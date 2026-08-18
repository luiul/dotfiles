import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	modelIdentity,
	normalizeCost,
	type BedrockModelsMap,
	type ModelCandidate,
	type ModelLike,
	type NormalizedCost,
	type ScopedModelLike,
} from "./core.ts";

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CACHE_FILE = "model-scores.json";

export type CacheState = "ready" | "unknown" | "stale" | "unavailable";
export type SourceState = "ready" | "stale" | "error" | "unknown";

export interface SourceStatus {
	state: SourceState;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	error: string | null;
}

export interface ModelCacheRecord {
	provider: string;
	modelId: string;
	canonicalModelId: string;
	baseModelId: string;
	route: string | null;
	invocationRegion: string | null;
	api: string | null;
	name: string | null;
	reasoning: boolean | null;
	input: string[];
	contextWindow: number | null;
	maxTokens: number | null;
	cost: NormalizedCost | null;
	readiness: "ready" | "unknown" | "unavailable";
	state: CacheState;
	costSource: string | null;
	metadataSource: string;
	lastSeenAt: string;
}

export interface ModelScoresCache {
	schemaVersion: typeof CACHE_SCHEMA_VERSION;
	generatedAt: string;
	inventory: {
		scope: "scoped" | "available";
		count: number;
	};
	models: Record<string, ModelCacheRecord>;
	sources: Record<string, SourceStatus>;
}

export function cacheKey(provider: string, modelId: string): string {
	return JSON.stringify([provider, modelId]);
}

function nullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function sourceStatus(state: SourceState, now: string, error: string | null = null): SourceStatus {
	return {
		state,
		lastAttemptAt: now,
		lastSuccessAt: state === "ready" ? now : null,
		error,
	};
}

export function cacheRecordFromCandidate<TModel extends ModelLike>(
	candidate: ModelCandidate<TModel>,
	now = new Date().toISOString(),
): ModelCacheRecord {
	const model = candidate.model;
	const cost = normalizeCost(model.cost);
	return {
		provider: candidate.identity.provider,
		modelId: candidate.identity.exactModelId,
		canonicalModelId: candidate.identity.canonicalModelId,
		baseModelId: candidate.identity.baseModelId,
		route: candidate.identity.route,
		invocationRegion: candidate.identity.invocationRegion,
		api: model.api ?? null,
		name: typeof model.name === "string" && model.name.length > 0 ? model.name : null,
		reasoning: nullableBoolean(model.reasoning),
		input: model.input ? [...model.input] : [],
		contextWindow: nullableNumber(model.contextWindow),
		maxTokens: nullableNumber(model.maxTokens),
		cost,
		readiness: "unknown",
		state: "ready",
		costSource: cost ? (candidate.identity.provider === "amazon-bedrock" ? "AWS Bedrock pricing" : "pi model metadata") : null,
		metadataSource: "pi runtime model metadata",
		lastSeenAt: now,
	};
}

export function buildCacheSnapshot<TModel extends ModelLike>(
	models: readonly ScopedModelLike<TModel>[],
	options: {
		scope: "scoped" | "available";
		bedrockMap?: BedrockModelsMap;
		currentRegion?: string;
		previous?: ModelScoresCache;
		now?: string;
		readinessForModel?: (model: TModel) => ModelCacheRecord["readiness"];
	} = { scope: "available" },
): ModelScoresCache {
	const now = options.now ?? new Date().toISOString();
	const records: Record<string, ModelCacheRecord> = {};
	for (const scoped of models) {
		const identity = modelIdentity(scoped.model, options.bedrockMap);
		const candidate: ModelCandidate<TModel> = {
			model: scoped.model,
			thinkingLevel: scoped.thinkingLevel,
			identity,
		};
		const key = cacheKey(identity.provider, identity.exactModelId);
		const previous = options.previous?.models[key];
		const record = cacheRecordFromCandidate(candidate, now);
		if (options.readinessForModel) record.readiness = options.readinessForModel(scoped.model);
		if (previous?.cost && !record.cost) {
			record.cost = previous.cost;
			record.costSource = previous.costSource;
		}
		record.readiness = previous?.readiness ?? record.readiness;
		records[key] = record;
	}

	const previousSources = options.previous?.sources ?? {};
	const pricingReady = Object.values(records).some((record) => record.cost !== null);
	const sources: Record<string, SourceStatus> = {
		...previousSources,
		pi: sourceStatus("ready", now),
		bedrockRegionMap: options.bedrockMap ? sourceStatus("ready", now) : (previousSources.bedrockRegionMap ?? sourceStatus("unknown", now)),
		bedrockPricing: pricingReady
			? sourceStatus("ready", now)
			: (previousSources.bedrockPricing ?? sourceStatus("unknown", now)),
	};

	return {
		schemaVersion: CACHE_SCHEMA_VERSION,
		generatedAt: now,
		inventory: { scope: options.scope, count: models.length },
		models: records,
		sources,
	};
}

export function markSourceFailure(
	cache: ModelScoresCache,
	source: string,
	error: unknown,
	now = new Date().toISOString(),
): ModelScoresCache {
	const previous = cache.sources[source];
	return {
		...cache,
		sources: {
			...cache.sources,
			[source]: {
				state: previous?.lastSuccessAt ? "stale" : "error",
				lastAttemptAt: now,
				lastSuccessAt: previous?.lastSuccessAt ?? null,
				error: error instanceof Error ? error.message : String(error),
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateCache(value: unknown): value is ModelScoresCache {
	if (!isRecord(value) || value.schemaVersion !== CACHE_SCHEMA_VERSION || typeof value.generatedAt !== "string") return false;
	if (!isRecord(value.inventory) || !isRecord(value.models) || !isRecord(value.sources)) return false;
	if (value.inventory.scope !== "scoped" && value.inventory.scope !== "available") return false;
	if (typeof value.inventory.count !== "number" || !Number.isInteger(value.inventory.count) || value.inventory.count < 0) return false;
	for (const record of Object.values(value.models)) {
		if (!isRecord(record)) return false;
		if (typeof record.provider !== "string" || typeof record.modelId !== "string") return false;
		if (typeof record.lastSeenAt !== "string" || !Array.isArray(record.input)) return false;
		if (!["ready", "unknown", "stale", "unavailable"].includes(String(record.state))) return false;
		if (!["ready", "unknown", "unavailable"].includes(String(record.readiness))) return false;
	}
	return true;
}

export function readCache(path: string): ModelScoresCache | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return validateCache(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isCacheStale(cache: ModelScoresCache, now = Date.now()): boolean {
	const generatedAt = Date.parse(cache.generatedAt);
	return !Number.isFinite(generatedAt) || now - generatedAt > CACHE_TTL_MS;
}

export function writeCacheAtomic(path: string, cache: ModelScoresCache): void {
	if (!validateCache(cache)) throw new Error("Refusing to write invalid model scores cache");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	chmodSync(path, 0o600);
}

export function withCacheLock<T>(path: string, operation: () => T, timeoutMs = 2_000): T {
	const startedAt = Date.now();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	while (true) {
		try {
			mkdirSync(path, { mode: 0o700 });
			break;
		} catch (error) {
			try {
				const age = Date.now() - statSync(path).mtimeMs;
				if (age > timeoutMs * 2) {
					unlinkSync(path);
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for cache lock: ${path}`);
		}
	}
	try {
		return operation();
	} finally {
		try {
			unlinkSync(path);
		} catch {
			// Another process may have cleaned a stale lock while this operation ran.
		}
	}
}

export function writeCacheLocked(path: string, cache: ModelScoresCache): void {
	withCacheLock(`${path}.lock`, () => writeCacheAtomic(path, cache));
}
