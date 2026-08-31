/**
 * cop draft prompt: load `.cop-prompt` into pi's editor WITHOUT submitting it.
 *
 * `cop new --prompt` (coppice#23) hands the prompt to wt's pi-prompt
 * post-switch hook, which delivers it to the worktree's VS Code window (see
 * ~/.config/worktrunk/cop-prompt-deliver.sh). The hook used to launch
 * `pi '<prompt>'`, which SUBMITS the prompt immediately. It now writes the
 * prompt to `<worktree>/.cop-prompt` and launches bare `pi`; this extension
 * picks the file up here and prefills the editor via setEditorText, so the
 * prompt can be reviewed/edited and is only sent when the user hits Enter.
 *
 * The file is deleted once its content is sitting in the editor, so it never
 * prefills twice and never lingers as an untracked file in the worktree. If
 * the editor already has content (the user typed during startup) the file is
 * left in place instead of clobbering anything.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_FILE = ".cop-prompt";
// 40 x 250ms = up to 10s waiting for the TUI editor to mount (session_start
// fires before it exists; until then getEditorText/setEditorText throw).
const MAX_ATTEMPTS = 40;
const RETRY_MS = 250;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI) return;
		const file = join(ctx.cwd, PROMPT_FILE);
		if (!existsSync(file)) return;
		const prompt = readFileSync(file, "utf8");
		if (!prompt.trim()) {
			rmSync(file, { force: true });
			return;
		}
		// Deliberately NOT awaited: pi may await session_start handlers before
		// the TUI (and its editor) exists, so blocking here on the editor would
		// deadlock the prefill. Run detached and poll until the editor is up.
		void (async () => {
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				try {
					const current = ctx.ui.getEditorText();
					if (current === prompt) {
						// Confirmed sitting in the editor (re-checked after setting:
						// a late startup reset just re-triggers the set below).
						rmSync(file, { force: true });
						return;
					}
					if (current.trim()) {
						ctx.ui.notify(`cop: editor not empty; prompt left in ${PROMPT_FILE}`, "warning");
						return;
					}
					ctx.ui.setEditorText(prompt);
				} catch {
					// Editor not mounted yet; retry.
				}
				await new Promise((r) => setTimeout(r, RETRY_MS));
			}
			ctx.ui.notify(`cop: could not load ${PROMPT_FILE} into the editor`, "error");
		})();
	});
}
