/**
 * Pass pi thinking levels to OpenAI GPT 5.6 models on Bedrock.
 *
 * pi-ai's Bedrock adapter currently builds reasoning fields only for Claude.
 * GPT 5.6 accepts the Converse API extension:
 *   additionalModelRequestFields: { reasoning: { effort } }
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

function isGpt56Model(modelId: string | undefined): boolean {
	return modelId?.includes("openai.gpt-5.6-") ?? false;
}

function effortFor(level: ThinkingLevel | undefined): string | undefined {
	switch (level) {
		case "off":
			return "none";
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return level;
		case undefined:
			return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let modelId: string | undefined;
	let thinkingLevel: ThinkingLevel | undefined;

	pi.on("session_start", (_event, ctx) => {
		modelId = ctx.model?.id;
		thinkingLevel = ctx.thinkingLevel;
	});

	pi.on("model_select", (event) => {
		modelId = event.model?.id;
	});

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = event.level;
	});

	pi.on("before_provider_request", (event) => {
		if (!isGpt56Model(modelId)) return;

		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

		const providerPayload = payload as ProviderPayload;
		const effort = effortFor(thinkingLevel);
		if (!effort) return;

		return {
			...providerPayload,
			additionalModelRequestFields: {
				...providerPayload.additionalModelRequestFields,
				reasoning: {
					...(providerPayload.additionalModelRequestFields?.reasoning as Record<string, unknown> | undefined),
					effort,
				},
			},
		};
	});
}
