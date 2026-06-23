import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(homedir(), ".pi", "scratch");
const RENDER = join(homedir(), ".pi", "agent", "mdx", "render.py");

/** Pull the text of the most recent assistant message on the current branch. */
function lastAssistantText(ctx: ExtensionCommandContext): string | null {
  const branch = ctx.sessionManager.getBranch();
  const assistant = branch
    .filter(
      (e: any) => e.type === "message" && e.message?.role === "assistant",
    )
    .sort(
      (a: any, b: any) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  const last = assistant.at(-1);
  if (!last) return null;

  const content = (last as any).message.content;
  if (typeof content === "string") return content.trim() || null;
  const text = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
  return text || null;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "answer"
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mdx", {
    description: "Render my last answer as a rich interactive HTML doc",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const text = lastAssistantText(ctx);
      if (!text) {
        ctx.ui.notify("No previous answer to render.", "warn");
        return;
      }

      // Title from first H1, else first non-empty line.
      let title = "";
      for (const line of text.split("\n")) {
        const m = line.match(/^#\s+(.+)/);
        if (m) {
          title = m[1].trim();
          break;
        }
      }
      if (!title) {
        title =
          text
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0)
            ?.replace(/[#*`>_-]/g, "")
            .trim()
            .slice(0, 60) ?? "Answer";
      }

      const slug = args.trim() ? slugify(args) : slugify(title);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
      const mdPath = join(SCRATCH, `mdx-${slug}-${stamp}.md`);

      // Ensure the doc opens with an H1 so the viewer has a title block.
      const body = /^#\s+/.test(text.trimStart())
        ? text
        : `# ${title}\n\n${text}`;

      mkdirSync(SCRATCH, { recursive: true });
      writeFileSync(mdPath, body, "utf8");

      const child = spawn("uv", ["run", RENDER, mdPath], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", (err) =>
        ctx.ui.notify(`mdx render failed: ${err.message}`, "error"),
      );
      child.unref();

      const htmlPath = mdPath.replace(/\.md$/, ".html");
      ctx.ui.notify(`Rendering last answer -> ${htmlPath}`, "info");
    },
  });
}
