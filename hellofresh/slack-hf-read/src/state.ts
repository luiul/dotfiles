import { execFileSync } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

const messages = {
	bad_arguments: "Invalid command or arguments.",
	session_needed: "Start the dedicated Slack login browser first.",
	wrong_browser: "The browser is not the managed Brave Beta session.",
	wrong_profile: "The browser profile is not the dedicated Slack profile.",
	untrusted_origin: "The page is not a trusted Slack origin.",
	wrong_workspace: "The page is not in the HelloFresh workspace.",
	lock_busy: "Another session command owns the lock, or its owner cannot be verified.",
	state_invalid: "Local session state is invalid or unsafe. No Slack action was taken.",
	auth_lost: "Slack sign-in was lost. The cause is unknown. Verify login before resuming.",
	paused: "Slack reads are paused. Verify login before resuming.",
	network_failure: "The Slack connection failed. No automatic retry was made.",
	rate_limited: "Slack limited the request. No automatic retry was made.",
	timeout: "The operation reached its time limit.",
	cancelled: "The operation was cancelled.",
	ui_changed: "The Slack page could not be read safely.",
	cleanup_failed: "Local session cleanup could not be completed safely.",
} as const;

type ErrorCode = keyof typeof messages;
function knownCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && Object.hasOwn(messages, value);
}

export class ReaderError extends Error {
	readonly code: string;
	constructor(code: string) {
		const safeCode = knownCode(code) ? code : "state_invalid";
		super(messages[safeCode]);
		this.name = "ReaderError";
		this.code = safeCode;
	}
}

export type RuntimeState = {
	schema_version: 1;
	paused: boolean;
	pause_reason?: string;
	last_successful_read?: string;
	last_auth_failure?: string;
	browser?: { pid: number; started: string; profile: string; target_id?: string; holder_id?: string };
	events: Array<{ at: string; command: string; outcome: string; duration_ms: number }>;
};

const commands = new Set(["status", "pause", "login", "await-login", "doctor", "channels", "history", "replies", "search", "read"]);
const reads = new Set(["channels", "history", "replies", "search", "read"]);
const pauseReasons = new Set(["user", "auth_lost"]);
const stateName = "state.json";
const lockName = ".slack-hf-read.lock";
const recoveryName = ".slack-hf-read.lock.recovery";
const ownerName = "owner.json";
const maxFileBytes = 128 * 1024;

function invalid(): never { throw new ReaderError("state_invalid"); }
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validPID(pid: unknown): pid is number {
	return Number.isSafeInteger(pid) && (pid as number) > 0 && (pid as number) <= 2_147_483_647;
}
function validStarted(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = value.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/);
	if (!match) return false;
	const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[2]);
	const day = Number(match[3]);
	const year = Number(match[7]);
	const date = new Date(Date.UTC(year, month, day));
	return year >= 1970 && day > 0 && date.getUTCMonth() === month
		&& ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] === match[1];
}
function validTime(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function outcome(value: unknown): value is string {
	return value === "success" || knownCode(value);
}

// Build a fresh allowlisted object. Arguments, message content, and unknown keys
// never reach the local audit file, even if a caller adds them to a state object.
function projectState(value: unknown): RuntimeState {
	if (!object(value) || value.schema_version !== 1 || typeof value.paused !== "boolean" || !Array.isArray(value.events)) invalid();
	const state: RuntimeState = { schema_version: 1, paused: value.paused, events: [] };
	if (value.pause_reason !== undefined) {
		if (typeof value.pause_reason !== "string" || !pauseReasons.has(value.pause_reason) || !state.paused) invalid();
		state.pause_reason = value.pause_reason;
	}
	for (const key of ["last_successful_read", "last_auth_failure"] as const) {
		if (value[key] !== undefined) {
			if (!validTime(value[key])) invalid();
			state[key] = value[key];
		}
	}
	if (value.browser !== undefined) {
		const browser = value.browser;
		if (!object(browser) || !validPID(browser.pid) || !validStarted(browser.started)
			|| typeof browser.profile !== "string" || !isAbsolute(browser.profile) || browser.profile.length > 4096
			|| /[\x00-\x1f\x7f]/.test(browser.profile)) invalid();
		state.browser = { pid: browser.pid, started: browser.started, profile: browser.profile };
		for (const key of ["target_id", "holder_id"] as const) {
			if (browser[key] !== undefined) {
				if (typeof browser[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(browser[key])) invalid();
				state.browser[key] = browser[key];
			}
		}
	}
	for (const event of value.events) {
		if (!object(event) || !validTime(event.at) || typeof event.command !== "string" || !commands.has(event.command)
			|| !outcome(event.outcome) || !Number.isSafeInteger(event.duration_ms) || (event.duration_ms as number) < 0) invalid();
		state.events.push({ at: event.at, command: event.command, outcome: event.outcome, duration_ms: event.duration_ms as number });
	}
	state.events = state.events.slice(-100);
	return state;
}

function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function owned(stat: Stats, directory: boolean): void {
	const uid = process.getuid?.();
	if (uid === undefined || stat.uid !== uid || stat.isSymbolicLink()
		|| (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) invalid();
}
function hasCode(error: unknown, code: string): boolean {
	return object(error) && error.code === code;
}
async function optionalStat(path: string): Promise<Stats | undefined> {
	try { return await lstat(path); }
	catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
async function assertSame(path: string, stat: Stats, directory: boolean): Promise<void> {
	const current = await lstat(path);
	owned(current, directory);
	if (!same(current, stat)) invalid();
}
async function privateDirectory(path: string, create = false, repair = true): Promise<Stats> {
	if (create) await mkdir(path, { recursive: true, mode: 0o700 });
	const before = await lstat(path);
	owned(before, true);
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		owned(stat, true);
		if (!same(before, stat)) invalid();
		if (repair) await handle.chmod(0o700);
		else if ((stat.mode & 0o777) !== 0o700) invalid();
		await assertSame(path, stat, true);
		return stat;
	} finally { await handle.close(); }
}
async function privateFile(path: string, repair = true): Promise<{ text: string; stat: Stats } | undefined> {
	const before = await optionalStat(path);
	if (!before) return undefined;
	owned(before, false);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		owned(stat, false);
		if (!same(before, stat) || stat.size > maxFileBytes) invalid();
		if (repair) await handle.chmod(0o600);
		else if ((stat.mode & 0o777) !== 0o600) invalid();
		const text = await handle.readFile("utf8");
		if (Buffer.byteLength(text) > maxFileBytes) invalid();
		await assertSame(path, stat, false);
		return { text, stat };
	} finally { await handle.close(); }
}
function safe(error: unknown, fallback: ErrorCode = "state_invalid"): ReaderError {
	return error instanceof ReaderError ? new ReaderError(error.code) : new ReaderError(fallback);
}

export class StateStore {
	readonly root: string;
	private pending: Promise<void> = Promise.resolve();
	constructor(root: string) { this.root = resolve(root); }

	async read(): Promise<RuntimeState> {
		try {
			await privateDirectory(this.root, true);
			const file = await privateFile(join(this.root, stateName));
			return file ? projectState(JSON.parse(file.text)) : { schema_version: 1, paused: false, events: [] };
		} catch (error) { throw safe(error); }
	}

	private serialize(action: () => Promise<void>): Promise<void> {
		const next = this.pending.then(action);
		this.pending = next.catch(() => {});
		return next;
	}

	write(state: RuntimeState): Promise<void> {
		return this.serialize(() => this.writePrivate(state));
	}

	private async writePrivate(state: RuntimeState): Promise<void> {
		let handle: FileHandle | undefined;
		let temporary: string | undefined;
		let temporaryStat: Stats | undefined;
		try {
			const text = `${JSON.stringify(projectState(state))}\n`;
			if (Buffer.byteLength(text) > maxFileBytes) invalid();
			const directory = await privateDirectory(this.root, true);
			const path = join(this.root, stateName);
			// Do not replace an unsafe destination, even though rename would not
			// follow a destination symlink.
			await privateFile(path);
			temporary = join(this.root, `.state.${randomBytes(24).toString("hex")}.tmp`);
			handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			temporaryStat = await handle.stat();
			owned(temporaryStat, false);
			await handle.chmod(0o600);
			await handle.writeFile(text);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await assertSame(this.root, directory, true);
			await privateFile(path);
			await assertSame(temporary, temporaryStat, false);
			await rename(temporary, path);
			temporary = undefined;
		} catch (error) { throw safe(error); }
		finally {
			await handle?.close().catch(() => {});
			if (temporary && temporaryStat) {
				try { await assertSame(temporary, temporaryStat, false); await unlink(temporary); }
				catch { /* Leave an unknown file untouched. Never expose a raw error. */ }
			}
		}
	}

	record(command: string, result: string, durationMs: number): Promise<void> {
		return this.serialize(async () => {
			if (!commands.has(command) || !outcome(result) || !Number.isFinite(durationMs) || durationMs < 0
				|| !Number.isSafeInteger(Math.round(durationMs))) throw new ReaderError("bad_arguments");
			const state = await this.read();
			const at = new Date().toISOString();
			state.events.push({ at, command, outcome: result, duration_ms: Math.round(durationMs) });
			state.events = state.events.slice(-100);
			if (result === "auth_lost") {
				state.paused = true;
				state.pause_reason = "auth_lost"; // This records a symptom, not its cause.
				state.last_auth_failure = at;
			} else if (result === "success" && reads.has(command)) state.last_successful_read = at;
			await this.writePrivate(state);
		});
	}

	resume(): Promise<void> {
		return this.serialize(async () => {
			const state = await this.read();
			state.paused = false;
			delete state.pause_reason;
			await this.writePrivate(state);
		});
	}

	pause(): Promise<void> {
		return this.serialize(async () => {
			const state = await this.read();
			state.paused = true;
			state.pause_reason = "user";
			await this.writePrivate(state);
		});
	}
}

export function processStarted(pid: number): string | undefined {
	if (!validPID(pid)) return undefined;
	try {
		const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
			env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024,
		}).trim();
		return validStarted(started) ? started : undefined;
	} catch { return undefined; }
}

// A failed ps call is not evidence of a dead process. Only ESRCH permits
// recovery when no process start time is available.
function ownerAlive(owner: { pid: number; started: string }): boolean {
	const started = processStarted(owner.pid);
	if (started !== undefined) return started === owner.started;
	try { process.kill(owner.pid, 0); return true; }
	catch (error) { return !hasCode(error, "ESRCH"); }
}

type Owner = { pid: number; started: string; token: string };
type LockSnapshot = { directory: Stats; file?: Stats; owner?: Owner };
async function lockSnapshot(root: string): Promise<LockSnapshot | undefined> {
	const path = join(root, lockName);
	if (!await optionalStat(path)) return undefined;
	const directory = await privateDirectory(path, false, false);
	const file = await privateFile(join(path, ownerName), false);
	if (!file) return { directory };
	try {
		const value: unknown = JSON.parse(file.text);
		if (object(value) && validPID(value.pid) && validStarted(value.started)
			&& typeof value.token === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.token)) {
			return { directory, file: file.stat, owner: { pid: value.pid, started: value.started, token: value.token } };
		}
	} catch { /* An unknown owner is never recovered automatically. */ }
	return { directory, file: file.stat };
}

export async function readLockOwner(root: string): Promise<{ pid: number; started: string; alive: boolean } | null> {
	try {
		root = resolve(root);
		await privateDirectory(root, true);
		const snapshot = await lockSnapshot(root);
		return snapshot?.owner ? { pid: snapshot.owner.pid, started: snapshot.owner.started, alive: ownerAlive(snapshot.owner) } : null;
	} catch (error) { throw safe(error); }
}

async function removeOwnedLock(root: string, expected: LockSnapshot, token: string): Promise<void> {
	const current = await lockSnapshot(root);
	if (!current?.owner || !current.file || !expected.file || !same(current.directory, expected.directory)
		|| !same(current.file, expected.file) || current.owner.token !== token) return;
	const path = join(root, lockName);
	const entries = await readdir(path);
	if (entries.length !== 1 || entries[0] !== ownerName) invalid();
	await assertSame(path, expected.directory, true);
	await assertSame(join(path, ownerName), current.file, false);
	await unlink(join(path, ownerName));
	// Never recursively delete. Unknown extra files keep the directory closed.
	await rmdir(path);
}

export async function acquireLock(root: string): Promise<{ release(): Promise<void> }> {
	root = resolve(root);
	const recoveryPath = join(root, recoveryName);
	const path = join(root, lockName);
	let recovery: Stats | undefined;
	let created: LockSnapshot | undefined;
	let token: string | undefined;
	try {
		await privateDirectory(root, true);
		// Live and unknown owners fail without occupying the recovery gate.
		// In particular, a rejected contender must not block owner cleanup.
		try {
			const existing = await lockSnapshot(root);
			if (existing && (!existing.owner || ownerAlive(existing.owner))) throw new ReaderError("lock_busy");
		} catch (error) {
			if (hasCode(error, "ENOENT")) throw new ReaderError("lock_busy");
			throw error;
		}
		// This atomic gate covers every acquisition, including stale recovery.
		// There is no waiting or retry. Unknown recovery directories fail closed.
		try { await mkdir(recoveryPath, { mode: 0o700 }); }
		catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			try { await privateDirectory(recoveryPath, false, false); }
			catch (check) {
				// The gate may close between mkdir(EEXIST) and inspection. That
				// still means this attempt lost the acquisition race.
				if (!hasCode(check, "ENOENT")) throw check;
			}
			throw new ReaderError("lock_busy");
		}
		recovery = await privateDirectory(recoveryPath);
		const previous = await lockSnapshot(root);
		if (previous) {
			if (!previous.owner || ownerAlive(previous.owner)) throw new ReaderError("lock_busy");
			await removeOwnedLock(root, previous, previous.owner.token);
		}
		try { await mkdir(path, { mode: 0o700 }); }
		catch (error) { if (hasCode(error, "EEXIST")) throw new ReaderError("lock_busy"); throw error; }
		created = { directory: await privateDirectory(path) };
		const started = processStarted(process.pid);
		if (!started) invalid();
		token = randomBytes(32).toString("hex");
		const owner: Owner = { pid: process.pid, started, token };
		const handle = await open(join(path, ownerName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			created.file = await handle.stat();
			owned(created.file, false);
			await handle.chmod(0o600);
			await handle.writeFile(`${JSON.stringify(owner)}\n`);
			await handle.sync();
			created.owner = owner;
		} finally { await handle.close(); }
		await assertSame(recoveryPath, recovery, true);
		await rmdir(recoveryPath);
		recovery = undefined;
		const snapshot = created;
		const ownToken = token;
		let releasing: Promise<void> | undefined;
		return {
			release(): Promise<void> {
				// Cache only a completed release. If cleanup fails, a caller can try
				// cleanup again, without sharing an in-flight unlink operation.
				if (!releasing) releasing = (async () => {
					let gate: Stats | undefined;
					try {
						await privateDirectory(root);
						await mkdir(recoveryPath, { mode: 0o700 });
						gate = await privateDirectory(recoveryPath);
						await removeOwnedLock(root, snapshot, ownToken);
					} finally {
						if (gate) { await assertSame(recoveryPath, gate, true); await rmdir(recoveryPath); }
					}
				})().catch(() => {
					releasing = undefined;
					throw new ReaderError("cleanup_failed");
				});
				return releasing;
			},
		};
	} catch (error) {
		if (created) {
			try {
				if (token && created.owner) await removeOwnedLock(root, created, token);
				else {
					await assertSame(path, created.directory, true);
					// rmdir cannot remove any unknown owner file.
					await rmdir(path);
				}
			} catch { /* Preserve any lock whose ownership is uncertain. */ }
		}
		throw safe(error);
	} finally {
		if (recovery) {
			try { await assertSame(recoveryPath, recovery, true); await rmdir(recoveryPath); }
			catch { throw new ReaderError("cleanup_failed"); }
		}
	}
}
