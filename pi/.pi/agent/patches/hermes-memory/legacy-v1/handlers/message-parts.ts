const CURSOR_TYPE = "hermes:review-cursor";
export const REVIEW_USER_CHARS = 16_000;
const OUTPUT_CHARS = 500;

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  return Number.isFinite(recentMessages) && recentMessages > 0
    ? parts.slice(-Math.floor(recentMessages)) : parts;
}

function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  return `${text.slice(0, head)}\n[TRUNCATED ${text.length - limit} characters. Read the source before saving facts from the omitted text.]\n${text.slice(-(limit - head))}`;
}

/** Keep source roles separate. Quoted content is evidence, never a reviewer instruction. */
export function collectMessageParts(entries: unknown[], recentMessages = 0): string[] {
  const parts: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, any>;
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const msg = entry.message;
    if (!["user", "assistant", "toolResult"].includes(msg.role)) continue;
    const text = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
    if (!text) continue;
    const role = msg.role === "user" ? "USER" : msg.role === "assistant" ? "ASSISTANT" : "TOOL_RESULT";
    const source = { entryId: typeof entry.id === "string" ? entry.id : null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      ...(msg.role === "toolResult" ? { tool: typeof msg.toolName === "string" ? msg.toolName : null, isError: msg.isError === true } : {}) };
    const content = boundedText(text, msg.role === "user" ? REVIEW_USER_CHARS : OUTPUT_CHARS);
    parts.push(`[${role}] source=${JSON.stringify(source)} content=${JSON.stringify(content)}`);
  }
  return applyRecentMessageLimit(parts, recentMessages);
}

/** A cursor only applies on the active branch and only while its source entry exists. */
export function collectReviewBatch(entries: unknown[], messageLimit = 0): { parts: string[]; cursor: { throughId: string } | null } {
  let after = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "custom" || entry.customType !== CURSOR_TYPE || typeof entry.data?.throughId !== "string") continue;
    const source = entries.findIndex((e: any) => e?.id === entry.data.throughId);
    if (source >= 0 && source < i) after = source;
    break;
  }
  const parts: string[] = [];
  let chars = 0;
  let throughId: string | undefined;
  for (const entry of entries.slice(after + 1) as any[]) {
    const part = collectMessageParts([entry])[0];
    if (!part) continue;
    if ((parts.length && chars + part.length > 48_000) || (messageLimit > 0 && parts.length >= Math.floor(messageLimit))) break;
    parts.push(part); chars += part.length;
    throughId = typeof entry.id === "string" ? entry.id : undefined;
  }
  return { parts, cursor: throughId ? { throughId } : null };
}

export function collectUnreviewedMessageParts(entries: unknown[], messageLimit = 0): string[] {
  return collectReviewBatch(entries, messageLimit).parts;
}

export function reviewCursor(entries: unknown[]): { throughId: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message?.role) && typeof entry.id === "string") return { throughId: entry.id };
  }
  return null;
}

export { CURSOR_TYPE };
