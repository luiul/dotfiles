/**
 * Select the working AWS region recorded by Orchard for the active model.
 *
 * https://github.com/luiul/orchard defines the discovery and probe workflow.
 * The region map is independent of Pi's curated enabledModels scope. This
 * extension makes cross-region selections work; it does not prove access or
 * filter Pi's model picker. An unknown ID falls back to the map's default.
 *
 * Bedrock resolves AWS_REGION for each request, so the region must change
 * before the next call, including the initial model of a resumed session.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bedrock-models.json");

interface BedrockModelsMap {
	generatedAt: string;
	defaultRegion: string;
	models: Record<string, string>;
}

let cached: BedrockModelsMap | undefined;
function loadMap(): BedrockModelsMap | undefined {
	// Re-read on each selection or session start so a new Orchard region map
	// takes effect without restarting Pi.
	try {
		cached = JSON.parse(readFileSync(MAP_PATH, "utf8"));
	} catch {
		// Missing/unreadable map: leave whatever AWS_REGION is already set
		// (or unset) alone rather than guessing.
		cached = undefined;
	}
	return cached;
}

function regionFor(map: BedrockModelsMap, modelId: string): string {
	return map.models[modelId] ?? map.defaultRegion;
}

function syncRegion(provider: string, modelId: string, ctx: ExtensionContext): void {
	if (provider !== "amazon-bedrock") {
		// Switching to a non-Bedrock model (e.g. ai-model-router): clear any
		// stale aws:<region> badge left by a previously selected Bedrock model.
		ctx.ui.setStatus("bedrock-region", undefined);
		return;
	}
	const map = loadMap();
	if (!map) return;

	const target = regionFor(map, modelId);
	const previous = process.env.AWS_REGION;
	if (previous === target) return;

	process.env.AWS_REGION = target;
	if (previous !== undefined) {
		ctx.ui.notify(`AWS_REGION: ${previous} -> ${target} (for ${modelId})`, "info");
	}
	ctx.ui.setStatus("bedrock-region", target === map.defaultRegion ? undefined : `aws:${target}`);
}

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		syncRegion(event.model.provider, event.model.id, ctx);
	});

	// Cover the initial model in effect at process start too (CLI --model,
	// settings.json defaultModel, or a resumed session) -- model_select only
	// fires on an actual change, not on the model already active.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) syncRegion(ctx.model.provider, ctx.model.id, ctx);
	});
}
