import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Cancel active work and exit Pi cleanly",
		handler: async (_args, ctx) => {
			// TUI abort also clears queued prompts. Wait before shutdown so manual
			// compaction cannot strand a deferred shutdown request.
			ctx.abort();
			await ctx.waitForIdle();
			ctx.shutdown();
		},
	});
}
