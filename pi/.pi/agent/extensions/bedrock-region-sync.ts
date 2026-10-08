/**
 * Select the working AWS region recorded by grove for the active model.
 *
 * https://github.com/luiul/grove defines the discovery and probe workflow.
 * The region map is the "grove" key inside models.json, a projection of
 * grove's store. An unknown ID falls back to the map's default region.
 *
 * Bedrock resolves AWS_REGION for each request, so the region must change
 * before the next call, including the initial model of a resumed session.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "models.json");

interface RegionMap {
	defaultRegion: string;
	regions: Record<string, string>;
}

function loadMap(): RegionMap | undefined {
	// Re-read on each selection or session start so a fresh grove sync takes
	// effect without restarting Pi. A missing grove key (or unreadable file)
	// leaves whatever AWS_REGION is already set alone rather than guessing.
	try {
		const doc = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
		const map = doc?.grove?.bedrock;
		if (typeof map?.defaultRegion !== "string" || typeof map?.regions !== "object") return undefined;
		return map;
	} catch {
		return undefined;
	}
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

	const target = map.regions[modelId] ?? map.defaultRegion;
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
