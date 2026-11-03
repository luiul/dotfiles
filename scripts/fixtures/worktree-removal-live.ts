// Local-only probe. It starts no model calls, Git scans, timers, or watchers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
 const note = (data: unknown) => appendFileSync(process.env.WORKTREE_REMOVAL_EVENTS!, JSON.stringify(data) + "\n");
 pi.on("session_start", (event, ctx) => {
  note({event: "start",reason:event.reason,mode:ctx.mode,pid:process.pid,commands:pi.getCommands().map(c=>c.name)});
 });
 pi.registerCommand("removal-check", {
  description: "Local fixture: verify retired completion command is absent",
  handler: (_args,ctx) => {
   const commands=pi.getCommands().map(c=>c.name);
   if(commands.includes("work-status"))throw Error("Retired command loaded");
   ctx.ui.notify("GUARD_REMOVAL_VERIFIED", "info");
   note({event:"checked",commands});
  }
 });
 pi.on("session_shutdown", (event) => note({event:"shutdown",reason:event.reason}));
}
