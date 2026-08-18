import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import {
	buildModelGroups,
	modelIdentity,
	normalizeCost,
	routeLabel,
	type BedrockModelsMap,
	type ModelLike,
	type ModelGroup,
	type ScopedModelLike,
} from "./core.ts";
import {
	buildCacheSnapshot,
	isCacheStale,
	readCache,
	writeCacheLocked,
	type ModelScoresCache,
} from "./cache.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const BEDROCK_MAP_PATH = join(AGENT_DIR, "bedrock-models.json");
const CACHE_PATH = join(AGENT_DIR, "data", "model-scores.json");
const COMMAND = "model-scores";

type PiModel = Model<any>;

function readBedrockMap(): BedrockModelsMap | undefined {
	try {
		const parsed = JSON.parse(readFileSync(BEDROCK_MAP_PATH, "utf8")) as BedrockModelsMap;
		if (!parsed || typeof parsed.defaultRegion !== "string" || !parsed.models) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function inScope(ctx: ExtensionContext): ScopedModelLike<PiModel>[] {
	if (ctx.scopedModels.length > 0) return ctx.scopedModels as ScopedModelLike<PiModel>[];
	return ctx.modelRegistry.getAvailable().map((model) => ({ model }));
}

function currentRegion(): string | undefined {
	return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
}

function costText(model: ModelLike): string {
	const cost = normalizeCost(model.cost);
	if (!cost) return "cost unknown";
	return `cost $${cost.input ?? "?"}/$${cost.output ?? "?"} per 1M`;
}

function parseFilters(args: string): { provider?: string; region?: string } {
	const filters: { provider?: string; region?: string } = {};
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	for (const token of tokens) {
		const [key, rawValue] = token.replace(/^--/u, "").split("=", 2);
		const value = rawValue?.replace(/^"|"$/gu, "").trim();
		if (!value) continue;
		if (key === "provider") filters.provider = value;
		if (key === "region") filters.region = value;
	}
	return filters;
}

function matchesFilters(model: PiModel, bedrockMap: BedrockModelsMap | undefined, filters: { provider?: string; region?: string }): boolean {
	if (filters.provider && model.provider !== filters.provider) return false;
	if (filters.region && modelIdentity(model, bedrockMap).invocationRegion !== filters.region) return false;
	return true;
}

function cacheCoversModels(cache: ModelScoresCache, models: readonly ScopedModelLike<PiModel>[]): boolean {
	if (cache.inventory.count !== models.length) return false;
	return models.every((scoped) => {
		const key = JSON.stringify([scoped.model.provider, scoped.model.id]);
		return cache.models[key] !== undefined;
	});
}

function cacheForModels(
	ctx: ExtensionContext,
	models: readonly ScopedModelLike<PiModel>[],
	bedrockMap: BedrockModelsMap | undefined,
	persist = false,
): ModelScoresCache {
	const previous = readCache(CACHE_PATH);
	if (previous && !persist && cacheCoversModels(previous, models)) return previous;
	const cache = buildCacheSnapshot(models, {
		scope: ctx.scopedModels.length > 0 ? "scoped" : "available",
		bedrockMap,
		previous,
		readinessForModel: (model) => (ctx.modelRegistry.hasConfiguredAuth(model) ? "ready" : "unavailable"),
	});
	writeCacheLocked(CACHE_PATH, cache);
	return cache;
}

function cacheStatusText(cache: ModelScoresCache): string {
	const age = isCacheStale(cache) ? "stale" : "ready";
	const pricing = cache.sources.bedrockPricing?.state ?? "unknown";
	return `cache ${age} · pricing ${pricing} · ${cache.inventory.count} inventory entries`;
}

function groupDescription(group: ModelGroup<PiModel>, cache: ModelScoresCache): string {
	const preferred = group.preferred;
	const identity = preferred.identity;
	const route = routeLabel(identity);
	const region = identity.invocationRegion ?? "region unknown";
	const candidates = group.candidates.length > 1 ? `, ${group.candidates.length} routes` : "";
	const record = cache.models[JSON.stringify([preferred.model.provider, preferred.model.id])];
	const stale = record?.state === "stale" || isCacheStale(cache) ? ", stale" : "";
	return `${preferred.model.provider}, ${route}, ${region}${candidates}${stale} · ctx ${preferred.model.contextWindow ?? "unknown"} · ${costText(preferred.model)}`;
}

function groupLabel(group: ModelGroup<PiModel>, active: PiModel | undefined): string {
	const selected = active && group.candidates.some((candidate) => candidate.model === active);
	return `${selected ? "● " : "  "}${group.label}`;
}

function detailLines(group: ModelGroup<PiModel>, cache: ModelScoresCache): string[] {
	const preferred = group.preferred;
	const identity = preferred.identity;
	const lines = [
		`${group.label}`,
		`provider: ${preferred.model.provider}`,
		`exact model: ${identity.exactModelId}`,
		`api: ${preferred.model.api ?? "unknown"}`,
		`route: ${routeLabel(identity)}`,
		`invocation region: ${identity.invocationRegion ?? "unknown"}`,
		`context: ${preferred.model.contextWindow ?? "unknown"} · max output: ${preferred.model.maxTokens ?? "unknown"}`,
		`reasoning: ${preferred.model.reasoning === undefined ? "unknown" : preferred.model.reasoning ? "yes" : "no"}`,
		`input: ${preferred.model.input?.join(", ") ?? "unknown"}`,
		`cost: ${costText(preferred.model)}`,
		`evidence: pi metadata and official Bedrock pricing, score: insufficient evidence`,
		`cache: ${cacheStatusText(cache)}`,
		`routes: ${group.candidates.map((candidate) => `${candidate.identity.exactModelId} (${candidate.identity.invocationRegion ?? "unknown"})`).join(", ")}`,
	];
	return lines;
}

async function selectModel(pi: ExtensionAPI, ctx: ExtensionContext, group: ModelGroup<PiModel>): Promise<boolean> {
	const selected = await pi.setModel(group.preferred.model);
	if (!selected) {
		ctx.ui.notify(`No credentials available for ${group.preferred.model.provider}/${group.preferred.model.id}`, "error");
		return false;
	}
	if (group.preferred.thinkingLevel) pi.setThinkingLevel(group.preferred.thinkingLevel);
	ctx.ui.notify(`Selected ${group.preferred.model.provider}/${group.preferred.model.id}`, "info");
	return true;
}

async function showSelector(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/model-scores requires interactive mode", "warning");
		return;
	}

	const bedrockMap = readBedrockMap();
	const scopedModels = inScope(ctx);
	const cache = cacheForModels(ctx, scopedModels, bedrockMap);
	const filters = parseFilters(args);
	const filteredModels = scopedModels.filter((scoped) => matchesFilters(scoped.model, bedrockMap, filters));
	const groups = buildModelGroups(filteredModels, bedrockMap, currentRegion());
	if (groups.length === 0) {
		ctx.ui.notify("No models match the current scope or filters", "warning");
		return;
	}

	const items: SelectItem[] = groups.map((group) => ({
		value: group.key,
		label: groupLabel(group, ctx.model),
		description: groupDescription(group, cache),
	}));

	const chosen = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Model scores")), 1, 0));
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`Offline companion picker · ${cacheStatusText(cache)} · ${filters.provider ? `provider=${filters.provider} ` : ""}${filters.region ? `region=${filters.region}` : ""}`,
				),
				1,
				0,
			),
		);
		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "type to filter · ↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!chosen) return;
	const group = groups.find((candidate) => candidate.key === chosen);
	if (!group) return;

	const candidateItems: SelectItem[] = group.candidates.map((candidate) => ({
		value: candidate.identity.exactModelId,
		label: `${candidate.identity.exactModelId}${candidate === group.preferred ? " (preferred)" : ""}`,
		description: `${routeLabel(candidate.identity)} · ${candidate.identity.invocationRegion ?? "region unknown"}`,
	}));
	const chosenCandidateId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Model details")), 1, 0));
		container.addChild(new Text(detailLines(group, cache).map((line) => theme.fg("muted", line)).join("\n"), 1, 0));
		const routes = new SelectList(candidateItems, Math.min(candidateItems.length, 6), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		routes.setSelectedIndex(Math.max(0, group.candidates.indexOf(group.preferred)));
		routes.onSelect = (item) => done(item.value);
		routes.onCancel = () => done(null);
		container.addChild(routes);
		container.addChild(new Text(theme.fg("dim", "type to filter routes · enter select exact model · esc back"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				routes.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (chosenCandidateId) {
		const candidate = group.candidates.find((item) => item.identity.exactModelId === chosenCandidateId);
		if (candidate) {
			const selected = await selectModel(pi, ctx, { ...group, preferred: candidate });
			if (!selected) await showSelector(pi, ctx, args);
		}
	}
}

export default function modelScoresExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "Open the offline scored model companion picker",
		handler: async (args, ctx) => {
			if (args.trim() === "sync") {
				const bedrockMap = readBedrockMap();
				const models = inScope(ctx);
				const cache = cacheForModels(ctx, models, bedrockMap, true);
				ctx.ui.notify(`Model scores cache synchronized: ${cache.inventory.count} entries, ${cacheStatusText(cache)}`, "info");
				return;
			}
			await showSelector(pi, ctx, args);
		},
	});
}
