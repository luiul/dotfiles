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

/** All assistant messages on the current branch, oldest first, text only. */
function assistantMessages(
  ctx: ExtensionCommandContext,
): { text: string; timestamp: string }[] {
  const branch = ctx.sessionManager.getBranch();
  return branch
    .filter((e: any) => e.type === "message" && e.message?.role === "assistant")
    .sort(
      (a: any, b: any) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    .map((e: any) => {
      const content = e.message.content;
      const text =
        typeof content === "string"
          ? content.trim()
          : content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
              .trim();
      return { text, timestamp: e.timestamp as string };
    })
    .filter((m: { text: string }) => m.text.length > 0);
}

function slugify(s: string, max = 48): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "answer";
  if (base.length <= max) return base;
  // Trim to the last whole word so slugs do not end mid-token.
  return base.slice(0, max).replace(/-[^-]*$/, "").replace(/-+$/, "") || base.slice(0, max);
}

/** Strip leading markdown markers and inline formatting, keeping the text. */
function cleanLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[>\-*+]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max);
}

function titleOf(text: string): string {
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)/);
    if (m) return cleanLine(m[1]) || "Answer";
  }
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "Answer";
  return truncateWords(cleanLine(first), 70) || "Answer";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mdx", {
    description:
      "Render an answer as a rich HTML doc (-s simple/verbatim, -t pick from history)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const simple = tokens.some((t) => t === "--simple" || t === "-s");
      const tree = tokens.some((t) => t === "--tree" || t === "-t");
      const enrich = !simple;
      const slugArg = tokens.find((t) => !t.startsWith("-"));

      const messages = assistantMessages(ctx);
      if (!messages.length) {
        ctx.ui.notify("No previous answer to render.", "warn");
        return;
      }

      let text = messages[messages.length - 1].text;
      if (tree && ctx.hasUI && messages.length > 1) {
        const recent = [...messages].reverse();
        const choices = recent.map(
          (m, i) =>
            `${i + 1}. ${i === 0 ? "(latest) " : ""}${truncateWords(titleOf(m.text), 60)}`,
        );
        const choice = await ctx.ui.select("Render which answer?", choices);
        if (!choice) return;
        const idx = parseInt(choice, 10) - 1;
        if (Number.isNaN(idx) || !recent[idx]) return;
        text = recent[idx].text;
      }

      const title = titleOf(text);
      const slug = slugArg ? slugify(slugArg) : slugify(title);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
      const mdPath = join(SCRATCH, `mdx-${slug}-${stamp}.md`);
      mkdirSync(SCRATCH, { recursive: true });

      if (enrich) {
        // Delegate to the agent: it restructures the answer, then renders.
        const prompt = [
          "Turn your previous answer into a rich, scannable review document, then render it.",
          "",
          "Do this:",
          `1. Restructure the content below into Markdown optimized for human scanning. Start with a single concise \`# Title\` H1 that summarizes the content, then a short **TL;DR**, then a **Decisions needed** task-list (\`- [ ] ...\`) when there are choices to make. Use \`##\`/\`###\` headings, tables for comparisons, \`>\` blockquotes for callouts, and backticks for files/identifiers/commands. Use \`\`\`mermaid\`\`\` diagrams for anything structural (architecture, flow, sequence, schema). Keep every substantive fact from the source; reorganize and visualize, do not invent or drop information.`,
          `2. Write the result to \`${mdPath}\`.`,
          `3. Run: \`uv run ${RENDER} ${mdPath}\``,
          "4. Print the absolute paths of the .md and .html files.",
          "",
          "Follow my writing style: no hyphens or em dashes as prose punctuation.",
          "",
          "Source answer to enrich:",
          "~~~markdown",
          text,
          "~~~",
        ].join("\n");

        pi.sendUserMessage(prompt, { triggerTurn: true });
        ctx.ui.notify(`Enriching last answer into ${mdPath} ...`, "info");
        return;
      }

      // Deterministic capture: write the answer verbatim and render it.
      const body = /^#\s+/.test(text.trimStart())
        ? text
        : `# ${title}\n\n${text}`;
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
