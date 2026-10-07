import { ReaderError } from "./state.ts";

export const TEAM_ID = "T02AGMUUR";
export const ORIGIN = "https://app.slack.com";
export type Command = "status" | "pause" | "login" | "await-login" | "doctor" | "channels" | "history" | "replies" | "search" | "read";
export interface Args {
	command: Command;
	limit: number;
	channel?: string;
	thread?: string;
	query?: string;
	after?: string;
	before?: string;
	permalink?: string;
	message?: string;
}

const commands = new Set<Command>(["status", "pause", "login", "await-login", "doctor", "channels", "history", "replies", "search", "read"]);
const defaults: Record<string, number> = { channels: 100, history: 30, replies: 50, search: 20, read: 10 };
const channelID = /^[CG][A-Z0-9]{8,}$/;

export function parsePermalink(value: string): { permalink: string; channel: string; message: string; thread?: string } {
	try {
		if (value.length > 1_000 || /[\x00-\x20\x7f]/.test(value)) throw new ReaderError("bad_arguments");
		const url = new URL(value);
		if (url.protocol !== "https:" || !["hellofresh.slack.com", "app.slack.com"].includes(url.hostname)
			|| url.username || url.password || url.port || url.hash) throw new ReaderError("bad_arguments");
		const match = url.pathname.match(/^\/archives\/([CG][A-Z0-9]{8,})\/p(\d{10})(\d{6})$/);
		if (!match) throw new ReaderError("bad_arguments");
		for (const key of url.searchParams.keys()) {
			if (!["thread_ts", "cid"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ReaderError("bad_arguments");
		}
		const thread = url.searchParams.get("thread_ts") ?? undefined;
		if (thread !== undefined && !/^\d{10}\.\d{6}$/.test(thread)) throw new ReaderError("bad_arguments");
		if (url.searchParams.has("cid") && url.searchParams.get("cid") !== match[1]) throw new ReaderError("bad_arguments");
		return { permalink: url.href, channel: match[1], message: `${match[2]}.${match[3]}`, thread };
	} catch { throw new ReaderError("bad_arguments"); }
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseArgs(argv: string[]): Args {
	const command = argv[0] as Command;
	if (!commands.has(command)) throw new ReaderError("bad_arguments");
	const values: Record<string, string> = {};
	const positional: string[] = [];
	const flags = new Set<string>(defaults[command] ? ["--limit"] : []);
	if (command === "history") { flags.add("--after"); flags.add("--before"); }
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			if (!flags.has(arg) || values[arg] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new ReaderError("bad_arguments");
			values[arg] = argv[++i];
		} else positional.push(arg);
	}
	const expected = command === "history" || command === "search" || command === "read" ? 1 : command === "replies" ? 2 : 0;
	if (positional.length !== expected) throw new ReaderError("bad_arguments");
	const limit = values["--limit"] ?? String(defaults[command] ?? 1);
	if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new ReaderError("bad_arguments");
	if ((command === "history" || command === "replies") && !channelID.test(positional[0])) throw new ReaderError("bad_arguments");
	if (command === "replies" && !/^\d{10}\.\d{6}$/.test(positional[1])) throw new ReaderError("bad_arguments");
	if (command === "search" && (!positional[0].trim() || positional[0].length > 500 || /[\x00-\x1f]/.test(positional[0]))) throw new ReaderError("bad_arguments");
	for (const flag of ["--after", "--before"]) if (values[flag] && !validDate(values[flag])) throw new ReaderError("bad_arguments");
	if (values["--after"] && values["--before"] && values["--after"] >= values["--before"]) throw new ReaderError("bad_arguments");
	const link = command === "read" ? parsePermalink(positional[0]) : undefined;
	return { command, limit: Number(limit), channel: command === "history" || command === "replies" ? positional[0] : link?.channel,
		thread: command === "replies" ? positional[1] : link?.thread, query: command === "search" ? positional[0] : undefined,
		after: values["--after"], before: values["--before"], permalink: link?.permalink, message: link?.message };
}

export function readURL(args: Args): string {
	const base = `${ORIGIN}/client/${TEAM_ID}`;
	if (args.command === "read") {
		const query = new URLSearchParams({ message_ts: args.message! });
		if (args.thread) { query.set("thread_ts", args.thread); query.set("cid", args.channel!); }
		return `${base}/${args.channel}?${query}`;
	}
	if (args.command === "history") return `${base}/${args.channel}`;
	if (args.command === "replies") return `${base}/${args.channel}/thread/${args.channel}-${args.thread}`;
	if (args.command === "search") return `${base}/search?q=${encodeURIComponent(args.query!)}`;
	return base;
}

export type LocationKind = "workspace" | "login" | "wrong_workspace" | "untrusted_origin";
export function locationKind(url: string): LocationKind {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return "untrusted_origin";
		if (parsed.hostname === "hellofresh.slack.com" && !parsed.pathname.startsWith("/archives/")) return "login";
		if (parsed.hostname === "slack.com" && /^\/(signin|workspace-signin|ssb|signout)(\/|$)/.test(parsed.pathname)) return "login";
		if (parsed.origin !== ORIGIN) return "untrusted_origin";
		if (/^\/(signin|workspace-signin|signout)(\/|$)/.test(parsed.pathname)) return "login";
		const match = parsed.pathname.match(/^\/client\/([^/]+)(\/|$)/);
		return match ? (match[1] === TEAM_ID ? "workspace" : "wrong_workspace") : "untrusted_origin";
	} catch { return "untrusted_origin"; }
}
