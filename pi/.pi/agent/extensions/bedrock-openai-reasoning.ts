/**
 * Pass pi thinking levels to OpenAI GPT 5.6 models on Bedrock.
 *
 * pi-ai's Bedrock adapter currently builds reasoning fields only for Claude.
 * GPT 5.6 accepts the Converse API extension:
 *   additionalModelRequestFields: { reasoning: { effort } }
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
	pi.on("before_provider_request", (event, ctx) => {
		if (!isGpt56Model(ctx.model?.id)) return;

		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

		const providerPayload = payload as ProviderPayload;
		const effort = effortFor(ctx.thinkingLevel);
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
