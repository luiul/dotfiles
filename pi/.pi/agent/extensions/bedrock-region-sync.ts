/**
 * Auto-switch AWS_REGION to match whichever Bedrock model is active.
 *
 * pi has no per-model region config: its amazon-bedrock provider always
 * invokes in whatever AWS_REGION is exported (or the sso-bedrock profile's
 * configured region, eu-west-1, if unset) -- see pi/.pi/agent/bin/
 * sync-enabled-models.sh for the full story. That script also writes
 * bedrock-models.json, a probe-verified { modelId: region } map covering
 * every region this account has usable Bedrock models in (not just the
 * default). enabledModels in settings.json is the full cross-region set from
 * that map, so /model and Ctrl+P show every model you can actually use --
 * this extension is what makes picking one of the non-default-region entries
 * (us./jp./au.-prefixed Claude, or region-pinned ON_DEMAND models like
 * moonshotai.kimi-*) actually work instead of 400ing.
 *
 * It works because Bedrock's region is resolved fresh on every request (see
 * @earendil-works/pi-ai's bedrock-converse-stream.js, which reads
 * process.env.AWS_REGION per call, not once at client construction), so
 * mutating process.env.AWS_REGION here before the next message is sent is
 * enough -- no client restart needed.
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
	// Re-read every time: the map is small, this file is only touched on
	// model_select/session_start (not hot-path), and it lets `sync-enabled-
	// models.sh` + `/reload` refresh it without restarting pi.
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
	if (provider !== "amazon-bedrock") return;
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
