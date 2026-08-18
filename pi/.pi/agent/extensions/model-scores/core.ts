export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelLike {
	provider: string;
	id: string;
	name: string;
	api?: string;
	reasoning?: boolean;
	input?: readonly string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ScopedModelLike<TModel extends ModelLike = ModelLike> {
	model: TModel;
	thinkingLevel?: ThinkingLevel;
}

export interface BedrockModelsMap {
	generatedAt?: string;
	defaultRegion: string;
	models: Record<string, string>;
}

export type BedrockRoute = "global" | "eu" | "us" | "au" | "jp" | "direct";

export interface ModelIdentity {
	provider: string;
	exactModelId: string;
	canonicalModelId: string;
	baseModelId: string;
	route: BedrockRoute | null;
	invocationRegion: string | null;
}

export interface ModelCandidate<TModel extends ModelLike = ModelLike> {
	model: TModel;
	thinkingLevel?: ThinkingLevel;
	identity: ModelIdentity;
}

export interface ModelGroup<TModel extends ModelLike = ModelLike> {
	key: string;
	provider: string;
	baseModelId: string;
	label: string;
	candidates: ModelCandidate<TModel>[];
	preferred: ModelCandidate<TModel>;
}

export interface NormalizedCost {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
}

const ROUTE_PREFIXES: Array<[prefix: string, route: Exclude<BedrockRoute, "direct">]> = [
	["global.", "global"],
	["eu.", "eu"],
	["us.", "us"],
	["au.", "au"],
	["jp.", "jp"],
];

export function modelIdentity(
	model: Pick<ModelLike, "provider" | "id">,
	bedrockMap?: BedrockModelsMap,
): ModelIdentity {
	const isBedrock = model.provider === "amazon-bedrock";
	const routePrefix = isBedrock ? ROUTE_PREFIXES.find(([prefix]) => model.id.startsWith(prefix)) : undefined;
	const canonicalModelId = routePrefix ? model.id.slice(routePrefix[0].length) : model.id;
	const invocationRegion = isBedrock
		? bedrockMap?.models[model.id] ?? bedrockMap?.defaultRegion ?? null
		: null;

	return {
		provider: model.provider,
		exactModelId: model.id,
		canonicalModelId,
		baseModelId: canonicalModelId,
		route: isBedrock ? (routePrefix?.[1] ?? "direct") : null,
		invocationRegion,
	};
}

function candidateRank<TModel extends ModelLike>(
	candidate: ModelCandidate<TModel>,
	currentRegion: string | undefined,
	defaultRegion: string | undefined,
): [number, number, string] {
	const regionRank =
		candidate.identity.invocationRegion !== null && candidate.identity.invocationRegion === currentRegion
			? 0
			: candidate.identity.invocationRegion !== null && candidate.identity.invocationRegion === defaultRegion
				? 1
				: 2;
		const routeRank = candidate.identity.route === "direct" ? 0 : 1;
		return [regionRank, routeRank, candidate.model.id];
}

function compareRank(left: [number, number, string], right: [number, number, string]): number {
	for (let index = 0; index < left.length; index++) {
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

export function buildModelGroups<TModel extends ModelLike>(
	scopedModels: readonly ScopedModelLike<TModel>[],
	bedrockMap?: BedrockModelsMap,
	currentRegion?: string,
): ModelGroup<TModel>[] {
	const groups = new Map<string, ModelGroup<TModel>>();
	const defaultRegion = bedrockMap?.defaultRegion;

	for (const scoped of scopedModels) {
		const identity = modelIdentity(scoped.model, bedrockMap);
		const key = `${identity.provider}\0${identity.baseModelId}`;
		const candidate: ModelCandidate<TModel> = {
			model: scoped.model,
			thinkingLevel: scoped.thinkingLevel,
			identity,
		};
		const existing = groups.get(key);
		if (existing) {
			existing.candidates.push(candidate);
			if (
				compareRank(
					candidateRank(candidate, currentRegion, defaultRegion),
					candidateRank(existing.preferred, currentRegion, defaultRegion),
				) < 0
			) {
				existing.preferred = candidate;
			}
			continue;
		}

		groups.set(key, {
			key,
			provider: identity.provider,
			baseModelId: identity.baseModelId,
			label: scoped.model.name || identity.baseModelId,
			candidates: [candidate],
			preferred: candidate,
		});
	}

	for (const group of groups.values()) {
		group.candidates.sort((left, right) =>
			compareRank(
				candidateRank(left, currentRegion, defaultRegion),
				candidateRank(right, currentRegion, defaultRegion),
			),
		);
		group.preferred = group.candidates[0];
	}

	return [...groups.values()].sort((left, right) => {
		const rank = compareRank(
			candidateRank(left.preferred, currentRegion, defaultRegion),
			candidateRank(right.preferred, currentRegion, defaultRegion),
		);
		if (rank !== 0) return rank;
		const contextDiff = (right.preferred.model.contextWindow ?? 0) - (left.preferred.model.contextWindow ?? 0);
		if (contextDiff !== 0) return contextDiff;
		return left.preferred.model.id.localeCompare(right.preferred.model.id);
	});
}

export function normalizeCost(cost: ModelLike["cost"]): NormalizedCost | null {
	if (!cost) return null;
	const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	if (values.every((value) => value === undefined || value === 0)) return null;
	return {
		input: typeof cost.input === "number" ? cost.input : null,
		output: typeof cost.output === "number" ? cost.output : null,
		cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : null,
		cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : null,
	};
}

export function routeLabel(identity: ModelIdentity): string {
	if (identity.route === null) return "route unknown";
	if (identity.route === "direct") return "direct";
	return `${identity.route} profile`;
}
