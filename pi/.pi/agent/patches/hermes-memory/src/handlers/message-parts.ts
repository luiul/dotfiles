const CURSOR_TYPE = "hermes:review-cursor";
export const REVIEW_USER_CHARS = 16_000;
export const REVIEW_BATCH_CHARS = 48_000;
const OUTPUT_CHARS = 500;

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  return Number.isFinite(recentMessages) && recentMessages > 0
    ? parts.slice(-Math.floor(recentMessages)) : parts;
}

/** Budget the JSON representation, including escaping and the omission marker. */
function quotedText(text: string, rawLimit: number, encodedLimit: number): string {
  const render = (keep: number) => {
    if (keep >= text.length) return JSON.stringify(text);
    const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    return JSON.stringify(`${text.slice(0, head)}\n[TRUNCATED ${text.length - keep} characters. Read the source before saving facts from the omitted text.]\n${tail ? text.slice(-tail) : ""}`);
  };
  const cap = Math.min(text.length, rawLimit);
  const candidate = render(cap);
  if (candidate.length <= encodedLimit) return candidate;
  let low = 0, high = cap;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= encodedLimit) low = middle;
    else high = middle - 1;
  }
  const result = render(low);
  if (result.length > encodedLimit) throw new Error("Evidence framing exceeds its budget");
  return result;
}

/** Keep roles and source fields distinct. Source omissions are quoted, never silent. */
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
    const sourceField = (value: unknown) => typeof value === "string" ? quotedText(value, 512, 1024) : "null";
    const source = `{"entryId":${sourceField(entry.id)},"timestamp":${sourceField(entry.timestamp)}${msg.role === "toolResult" ? `,"tool":${sourceField(msg.toolName)},"isError":${msg.isError === true}` : ""}}`;
    const prefix = `[${role}] source=${source} content=`;
    const content = quotedText(text, msg.role === "user" ? REVIEW_USER_CHARS : OUTPUT_CHARS, REVIEW_BATCH_CHARS - prefix.length);
    parts.push(prefix + content);
  }
  return applyRecentMessageLimit(parts, recentMessages);
}

/** Checkpoints cover only delivered oldest-first records, including separator costs. */
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
    const cost = part.length + (parts.length ? 2 : 0);
    if (chars + cost > REVIEW_BATCH_CHARS || (Number.isFinite(messageLimit) && messageLimit >= 1 && parts.length >= Math.floor(messageLimit))) break;
    parts.push(part); chars += cost;
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
