/**
 * Image cap for providers that reject requests with too many images.
 *
 * The HelloFresh AI Model Router (LiteLLM gateway, backed by Baseten) rejects
 * any request with more than 8 images for the GLM model group:
 *
 *   litellm.BadRequestError: BasetenException - Too many images: 11 (max 8)
 *
 * Pi resends the full conversation on every turn, so a session that reads or
 * attaches images accumulates them in context and permanently 400s once the
 * count crosses the limit (memory 2026-10-15: seen at 9, 10, and 11 images).
 *
 * Before each LLM call, this extension counts image parts across the whole
 * transcript. When the count exceeds the cap it keeps the most recent images
 * and replaces the oldest ones with a text placeholder that names the source
 * path, so the model knows an image existed and can re-read it on demand. The
 * `context` event is request-local: pi restores the transcript afterward, so
 * the session log keeps every image and only the outgoing request is trimmed.
 *
 * Scope: only models on the configured providers (default: `ai-model-router`).
 * Direct Bedrock and other providers keep their full image history.
 *
 * One TUI notice per changed drop count, not per request: within a run the
 * same images are trimmed on every LLM call, so per-request notices would
 * spam. Subagent/print sessions (no UI) trim silently.
 *
 * Config:
 * - MAX_IMAGES: 8 (the documented Baseten limit). Override with
 *   PI_IMAGE_CAP_MAX=<n> for testing or a different model group.
 * - /image-cap shows the active cap and whether the current model is scoped.
 *
 * Verification: bun scripts/test-router-image-cap.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Max images per request, from the Baseten GLM error message. */
const MAX_IMAGES = Math.max(1, Number(process.env.PI_IMAGE_CAP_MAX) || 8);

/** Providers whose upstream gateways enforce a per-request image limit. */
const SCOPED_PROVIDERS = new Set(["ai-model-router"]);

interface ImageLikePart {
	type: "image";
	data: string;
	mimeType: string;
}

/** Any message content item that is an image part. */
function isImagePart(part: unknown): part is ImageLikePart {
	return typeof part === "object" && part !== null && (part as { type?: string }).type === "image";
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return typeof part === "object" && part !== null && (part as { type?: string }).type === "text";
}

/** Content parts of a message, or undefined when not an array (string or tool-call content). */
function contentParts(message: unknown): unknown[] | undefined {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content : undefined;
}

/**
 * toolCallId -> human-readable source of the image (path or URL). Assistant
 * messages carry tool calls with their arguments; the matching toolResult
 * messages carry the images. Reading the path from the call arguments is more
 * reliable than the result's opaque `details`.
 */
function buildSourceMap(messages: unknown[]): Map<string, string> {
	const sources = new Map<string, string>();
	for (const message of messages) {
		const parts = contentParts(message);
		if (!parts) continue;
		for (const part of parts) {
			if (part === null || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") continue;
			const call = part as { id?: string; arguments?: Record<string, unknown> };
			if (!call.id || !call.arguments) continue;
			for (const key of ["path", "file_path", "url", "filePath"]) {
				const value = call.arguments[key];
				if (typeof value === "string" && value) {
					sources.set(call.id, value);
					break;
				}
			}
		}
	}
	return sources;
}

/** Count images in a single message. */
function countImages(message: unknown): number {
	const parts = contentParts(message);
	if (!parts) return 0;
	return parts.filter(isImagePart).length;
}

export default function (pi: ExtensionAPI) {
	/** Drop count of the previous request; a notice fires only when it changes. */
	let lastDropped = -1;

	pi.on("context", async (event, ctx: ExtensionContext) => {
		try {
			const provider = ctx.model?.provider;
			if (!provider || !SCOPED_PROVIDERS.has(provider)) return;

			const messages = event.messages as unknown[];
			const total = messages.reduce((sum, m) => sum + countImages(m), 0);
			const toDrop = total - MAX_IMAGES;
			if (toDrop <= 0) return;

			const sources = buildSourceMap(messages);
			const newMessages = messages.slice();
			let dropped = 0;

			for (let i = 0; i < newMessages.length && dropped < toDrop; i++) {
				const message = newMessages[i] as Record<string, unknown> & { role?: unknown };
				const parts = contentParts(message);
				if (!parts) continue;
				if (!parts.some(isImagePart)) continue;

				// Shallow-copy the message and its content array; never mutate the
				// transcript objects pi handed us, even though it restores them.
				const copy = { ...message };
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
				const source = toolCallId ? sources.get(toolCallId) : undefined;

				copy.content = parts.map((part) => {
					if (dropped < toDrop && isImagePart(part)) {
						dropped++;
						return {
							type: "text",
							text:
								`[Image omitted: ${source ?? (message.role === "user" ? "an attached user image" : "an earlier image")}. ` +
								`The model allows max ${MAX_IMAGES} images per request, so only the ${MAX_IMAGES} most recent were sent. ` +
								`Re-read the file if you need it.]`,
						};
					}
					return part;
				});
				newMessages[i] = copy;
			}

			if (dropped === 0) return; // defensive: count and parts disagreed

			if (dropped !== lastDropped) {
				lastDropped = dropped;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`image cap: dropped the ${dropped} oldest image${dropped === 1 ? "" : "s"} from the request ` +
							`(${total} in context, model max ${MAX_IMAGES}); the session transcript keeps all of them`,
						"warning",
					);
				}
			}

			return { messages: newMessages };
		} catch {
			// Never break the request over a trimming bug; the provider may 400,
			// which is the pre-existing behavior, but the session itself stays up.
			return;
		}
	});

	pi.registerCommand("image-cap", {
		description: "Show the per-request image cap and whether the current model is scoped",
		handler: async (_args, ctx: ExtensionContext) => {
			const provider = ctx.model?.provider;
			const scoped = provider !== undefined && SCOPED_PROVIDERS.has(provider);
			ctx.ui.notify(
				scoped
					? `Image cap: ${MAX_IMAGES} per request (provider ${provider}; older images are replaced with a placeholder)`
					: `Image cap inactive for provider ${provider ?? "(none)"}; it only applies to: ${[...SCOPED_PROVIDERS].join(", ")}`,
				"info",
			);
		},
	});
}
