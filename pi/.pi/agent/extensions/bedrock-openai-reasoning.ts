/**
 * Preserve explicit thinking off for OpenAI GPT 5.6 on Bedrock.
 *
 * Pi 1.6 sends native GPT reasoning fields for enabled thinking levels.
 * With thinking off it omits them. Keep the legacy explicit "none" field
 * until that provider behavior has been verified without this extension.
 *
 * Model id and thinking level are tracked in plain closure state, not read
 * from ctx inside before_provider_request. After session replacement or
 * reload, pi invalidates the old extension runner and every ctx getter
 * (ctx.model, ctx.thinkingLevel, ...) throws a stale-ctx error. A request
 * still in flight during the swap fires this hook on the stale runner, so
 * any ctx access here surfaces as an extension error. session_start,
 * model_select, and thinking_level_select run on the live runner and carry
 * everything needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

type ProviderPayload = {
	additionalModelRequestFields?: Record<string, unknown>;
	[key: string]: unknown;
};

export default function (pi: ExtensionAPI) {
	let matchesBedrockGpt = false;
	let thinkingLevel: ThinkingLevel | undefined;

	pi.on("session_start", (_event, ctx) => {
		matchesBedrockGpt = ctx.model?.api === "bedrock-converse-stream" && ctx.model.id.includes("openai.gpt-5.6-");
		thinkingLevel = ctx.thinkingLevel;
	});

	pi.on("model_select", (event) => {
		matchesBedrockGpt = event.model?.api === "bedrock-converse-stream" && event.model.id.includes("openai.gpt-5.6-");
	});

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
	});

	pi.on("before_provider_request", (event) => {
		if (!matchesBedrockGpt || thinkingLevel !== "off") return;

		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

		const providerPayload = payload as ProviderPayload;

		return {
			...providerPayload,
			additionalModelRequestFields: {
				...providerPayload.additionalModelRequestFields,
				reasoning: {
					...(providerPayload.additionalModelRequestFields?.reasoning as Record<string, unknown> | undefined),
					effort: "none",
				},
			},
		};
	});
}
