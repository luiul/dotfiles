import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loading the command adds no hooks, tools or prompt content. Evidence and UI
// code are loaded only when requested, and never change model selection.
export default function modelGuide(pi: ExtensionAPI) {
	pi.registerCommand("model-guide", {
		description: "Compare the current scoped models without changing selection",
		async handler(args, ctx) {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Model guide needs interactive Pi.", "info");
				return;
			}
			const { showGuide } = await import("./model-guide/view.ts");
			await showGuide(pi, ctx, args.trim());
		},
	});
}
