import { describe, expect, it } from "vitest";
import {
	buildModelGroups,
	modelIdentity,
	normalizeCost,
	type BedrockModelsMap,
	type ModelLike,
} from "../model-scores/core";

const bedrockMap: BedrockModelsMap = {
	defaultRegion: "eu-west-1",
	models: {
		"eu.anthropic.claude-sonnet-4-6": "eu-west-1",
		"global.anthropic.claude-sonnet-4-6": "eu-west-1",
		"us.anthropic.claude-sonnet-4-6": "us-east-1",
		"moonshotai.kimi-k2.5": "us-east-1",
	},
};

function model(id: string, provider = "amazon-bedrock", overrides: Partial<ModelLike> = {}): ModelLike {
	return {
		id,
		provider,
		name: id,
		contextWindow: 200_000,
		...overrides,
	};
}

describe("model scores inventory helpers", () => {
	it("keeps exact identity while separating Bedrock route and invocation region", () => {
		expect(modelIdentity(model("global.anthropic.claude-sonnet-4-6"), bedrockMap)).toMatchObject({
			exactModelId: "global.anthropic.claude-sonnet-4-6",
			baseModelId: "anthropic.claude-sonnet-4-6",
			route: "global",
			invocationRegion: "eu-west-1",
		});
		expect(modelIdentity(model("moonshotai.kimi-k2.5"), bedrockMap)).toMatchObject({
			exactModelId: "moonshotai.kimi-k2.5",
			baseModelId: "moonshotai.kimi-k2.5",
			route: "direct",
			invocationRegion: "us-east-1",
		});
	});

	it("groups route duplicates and prefers the current region", () => {
		const groups = buildModelGroups(
			[
				{ model: model("global.anthropic.claude-sonnet-4-6") },
				{ model: model("eu.anthropic.claude-sonnet-4-6") },
				{ model: model("us.anthropic.claude-sonnet-4-6") },
				{ model: model("moonshotai.kimi-k2.5") },
			],
			bedrockMap,
			"us-east-1",
		);

		expect(groups).toHaveLength(2);
		const claude = groups.find((group) => group.baseModelId === "anthropic.claude-sonnet-4-6");
		expect(claude?.candidates).toHaveLength(3);
		expect(claude?.preferred.model.id).toBe("us.anthropic.claude-sonnet-4-6");
	});

	it("normalizes pi's all zero cost default to absent data", () => {
		expect(normalizeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
		expect(normalizeCost({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(normalizeCost(undefined)).toBeNull();
	});
});
