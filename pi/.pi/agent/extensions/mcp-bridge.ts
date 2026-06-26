/**
 * MCP bridge for pi (streamable-HTTP transport).
 *
 * pi has no built-in MCP (see pi docs: usage.md "Design Principles"). This
 * extension bridges a remote MCP server into pi by discovering its tools at
 * session start and registering each one as a native pi tool, forwarding
 * `tools/call` over the wire.
 *
 * Default target is the HelloFresh GenAI-Lab KB (`hellofresh-kb`), the one
 * sanctioned MCP under the CLI-first rule (see HelloFresh AGENTS.md). It is
 * reachable on the corporate network without a token; the bridge still sends
 * an Authorization header if MCP_BRIDGE_TOKEN is set.
 *
 * Transport notes (MCP Streamable HTTP, 2025-06-18):
 *   - Requests are JSON-RPC POSTs.
 *   - Accept must include both application/json and text/event-stream.
 *   - Responses come back as an SSE stream (text/event-stream); we parse the
 *     `data:` lines and pick the JSON-RPC message matching our request id.
 *   - The server may issue an `mcp-session-id` response header on initialize;
 *     we echo it back on every subsequent request.
 *
 * Config (env):
 *   MCP_BRIDGE_URL     server endpoint (default: HelloFresh KB /mcp/v2)
 *   MCP_BRIDGE_PREFIX  pi tool-name prefix (default: "kb_")
 *   MCP_BRIDGE_TOKEN   optional bearer token (sent as Authorization header)
 *   MCP_BRIDGE_TIMEOUT per-request timeout ms (default: 30000)
 *
 * Commands:
 *   /mcp-tools   list the bridged tools and their source server
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL =
	"https://genai-lab-api.eu.foundations.shared.int.hellofresh.io/mcp/v2";

const URL = process.env.MCP_BRIDGE_URL || DEFAULT_URL;
const PREFIX = process.env.MCP_BRIDGE_PREFIX ?? "kb_";
const TOKEN = process.env.MCP_BRIDGE_TOKEN;
const TIMEOUT_MS = Number(process.env.MCP_BRIDGE_TIMEOUT || 30_000);
const PROTOCOL_VERSION = "2025-06-18";

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface McpContentBlock {
	type: string;
	text?: string;
	[k: string]: unknown;
}

// Session id handed out by the server on initialize, replayed on later calls.
let sessionId: string | undefined;

function baseHeaders(): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": PROTOCOL_VERSION,
	};
	if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
	if (sessionId) h["mcp-session-id"] = sessionId;
	return h;
}

// Pull the JSON-RPC payload out of an SSE (or plain JSON) HTTP response.
async function readRpcResult(
	res: Response,
	id: number,
): Promise<Record<string, unknown>> {
	const body = await res.text();
	const ct = res.headers.get("content-type") || "";

	const tryParse = (s: string): Record<string, unknown> | undefined => {
		try {
			const obj = JSON.parse(s);
			if (obj && typeof obj === "object") return obj as Record<string, unknown>;
		} catch {
			/* not json */
		}
		return undefined;
	};

	if (ct.includes("text/event-stream")) {
		// Concatenate data: lines per SSE event, parse, match our id.
		let dataBuf = "";
		let match: Record<string, unknown> | undefined;
		const flush = () => {
			if (!dataBuf) return;
			const obj = tryParse(dataBuf);
			dataBuf = "";
			if (obj && obj.id === id) match = obj;
		};
		for (const rawLine of body.split(/\r?\n/)) {
			if (rawLine === "") {
				flush();
				continue;
			}
			if (rawLine.startsWith("data:")) {
				dataBuf += rawLine.slice(5).replace(/^ /, "");
			}
		}
		flush();
		if (match) return match;
		throw new Error(`No JSON-RPC message for id ${id} in SSE response`);
	}

	const obj = tryParse(body);
	if (obj) return obj;
	throw new Error(`Unparseable MCP response (HTTP ${res.status}): ${body.slice(0, 300)}`);
}

// One JSON-RPC round trip. Returns the `result` object or throws on error.
async function rpc(
	method: string,
	params: Record<string, unknown> | undefined,
	id: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(URL, {
			method: "POST",
			headers: baseHeaders(),
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			signal: ctrl.signal,
		});
		const sid = res.headers.get("mcp-session-id");
		if (sid) sessionId = sid;
		if (!res.ok && !(res.headers.get("content-type") || "").includes("event-stream")) {
			const text = await res.text();
			throw new Error(`MCP ${method} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
		}
		const msg = await readRpcResult(res, id);
		if (msg.error) {
			const e = msg.error as { code?: number; message?: string };
			throw new Error(`MCP ${method} error ${e.code ?? ""}: ${e.message ?? "unknown"}`);
		}
		return (msg.result as Record<string, unknown>) ?? {};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

// A fire-and-forget JSON-RPC notification (no id, no response expected).
async function notify(method: string): Promise<void> {
	try {
		await fetch(URL, {
			method: "POST",
			headers: baseHeaders(),
			body: JSON.stringify({ jsonrpc: "2.0", method }),
		});
	} catch {
		/* best effort */
	}
}

let nextId = 1;

// MCP handshake: initialize -> notifications/initialized.
async function handshake(signal?: AbortSignal): Promise<void> {
	await rpc(
		"initialize",
		{
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-mcp-bridge", version: "1.0.0" },
		},
		nextId++,
		signal,
	);
	await notify("notifications/initialized");
}

async function listTools(signal?: AbortSignal): Promise<McpTool[]> {
	const result = await rpc("tools/list", {}, nextId++, signal);
	const tools = (result.tools as McpTool[]) || [];
	return tools.filter((t) => t && typeof t.name === "string");
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<McpContentBlock[]> {
	const result = await rpc("tools/call", { name, arguments: args }, nextId++, signal);
	const content = (result.content as McpContentBlock[]) || [];
	if (result.isError) {
		const text = content.map((c) => c.text ?? "").join("\n") || "tool returned isError";
		throw new Error(text);
	}
	return content;
}

// Map MCP content blocks onto pi tool-result content blocks.
function toPiContent(blocks: McpContentBlock[]): Array<{ type: "text"; text: string }> {
	const out: Array<{ type: "text"; text: string }> = [];
	for (const b of blocks) {
		if (b.type === "text" && typeof b.text === "string") {
			out.push({ type: "text", text: b.text });
		} else {
			// resource / image / unknown: surface as JSON so nothing is silently dropped.
			out.push({ type: "text", text: JSON.stringify(b) });
		}
	}
	if (out.length === 0) out.push({ type: "text", text: "(empty result)" });
	return out;
}

export default async function mcpBridge(pi: ExtensionAPI) {
	const registered: McpTool[] = [];

	// Discover + register at load time so tools exist immediately (and for /reload).
	try {
		await handshake();
		const tools = await listTools();
		for (const tool of tools) {
			const piName = `${PREFIX}${tool.name}`;
			const schema = (tool.inputSchema && Object.keys(tool.inputSchema).length > 0
				? tool.inputSchema
				: { type: "object", properties: {} }) as unknown;

			pi.registerTool({
				name: piName,
				label: tool.name,
				description: tool.description || `MCP tool ${tool.name}`,
				// MCP returns raw JSON Schema; pi validates it structurally at runtime.
				parameters: schema as never,
				async execute(_id, params, signal) {
					const blocks = await callTool(
						tool.name,
						(params ?? {}) as Record<string, unknown>,
						signal,
					);
					return {
						content: toPiContent(blocks),
						details: { server: URL, tool: tool.name },
					};
				},
			});
			registered.push(tool);
		}
	} catch (err) {
		// Don't break startup if the server is unreachable (e.g. off-VPN).
		const msg = err instanceof Error ? err.message : String(err);
		pi.on("session_start", (_e, ctx: ExtensionContext) => {
			ctx.ui.notify(`mcp-bridge: failed to load tools from ${URL}: ${msg}`, "warning");
		});
	}

	pi.on("session_start", (_e, ctx: ExtensionContext) => {
		if (registered.length > 0) {
			ctx.ui.notify(
				`mcp-bridge: ${registered.length} tool(s) from MCP server (prefix "${PREFIX}")`,
				"info",
			);
		}
	});

	pi.registerCommand("mcp-tools", {
		description: "List MCP tools bridged into pi",
		handler: async (_args, ctx) => {
			if (registered.length === 0) {
				ctx.ui.notify(`mcp-bridge: no tools loaded from ${URL}`, "warning");
				return;
			}
			const lines = registered
				.map((t) => `  ${PREFIX}${t.name} — ${(t.description || "").split("\n")[0].slice(0, 80)}`)
				.join("\n");
			ctx.ui.notify(`MCP server: ${URL}\n${lines}`, "info");
		},
	});
}
