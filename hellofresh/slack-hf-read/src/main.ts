/** Pi Slack reads use only the managed headed UI. Fail closed, never replay credentials. */
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { parseArgs, TEAM_ID, type Args } from "./args.ts";
import { ReaderError, StateStore, acquireLock, readLockOwner, processStarted } from "./state.ts";
import { acquireSession, startLogin, browserOwned, listenerLocal, type Session } from "./session.ts";
import { readUI, verifyLogin, redact } from "./ui.ts";

export interface Dependencies {
	store: StateStore;
	profile: string;
	root: string;
	acquire: typeof acquireSession;
	login: typeof startLogin;
	read: typeof readUI;
	verify: typeof verifyLogin;
	lock: typeof acquireLock;
	output: (value: unknown) => void;
	deadlineMs?: number;
}

function failure(error: unknown): ReaderError {
	if (error instanceof ReaderError) return error;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new ReaderError("timeout");
	return new ReaderError("network_failure");
}

export async function run(argv: string[], deps: Dependencies, signal?: AbortSignal): Promise<number> {
	let args: Args;
	try { args = parseArgs(argv); }
	catch {
		deps.output({ schema_version: 1, ok: false, error: "bad_arguments", message: new ReaderError("bad_arguments").message });
		return 2;
	}
	const started = Date.now();
	let lock: Awaited<ReturnType<typeof acquireLock>> | undefined;
	let session: Session | undefined;
	let error: ReaderError | undefined;
	let authRecorded = false;
	let output: unknown;
	const deadline = AbortSignal.timeout(deps.deadlineMs ?? (args.command === "await-login" ? 10 * 60_000 + 5_000 : 45_000));
	const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const stopped = () => new ReaderError(signal?.aborted ? "cancelled" : "timeout");
	let abortHandler: (() => void) | undefined;
	const abort = new Promise<never>((_, reject) => {
		abortHandler = () => reject(stopped());
		stop.addEventListener("abort", abortHandler, { once: true });
	});
	// Cancellation can happen during local attachment, before a UI race starts.
	void abort.catch(() => {});
	async function bounded<T>(operation: () => Promise<T>): Promise<T> {
		if (stop.aborted) throw stopped();
		return Promise.race([operation(), abort]);
	}
	try {
		if (stop.aborted) throw stopped();
		if (args.command === "status") {
			const state = await deps.store.read();
			let profileExists = false;
			try { const stat = await lstat(deps.profile); profileExists = stat.isDirectory() && !stat.isSymbolicLink(); } catch { /* Local status only. */ }
			const exists = async (name: string) => {
				try { await lstat(join(deps.root, name)); return true; } catch { return false; }
			};
			output = { schema_version: 1, ok: true, command: "status", paused: state.paused, pause_reason: state.pause_reason ?? null,
				last_successful_read: state.last_successful_read ?? null, last_auth_failure: state.last_auth_failure ?? null,
				profile: { exists: profileExists }, browser: { managed: !!state.browser, running: !!state.browser && processStarted(state.browser.pid) === state.browser.started,
					owned: !!state.browser && browserOwned(state.browser, deps.profile), localhost_listener: !!state.browser && listenerLocal(state.browser.pid) },
				lock_owner: await readLockOwner(deps.root), lock_present: await exists(".slack-hf-read.lock"), recovery_gate_present: await exists(".slack-hf-read.lock.recovery"), cause: "unknown", events: state.events };
		} else {
			lock = await deps.lock(deps.root);
			const state = await deps.store.read();
			if (state.paused && !["login", "await-login", "pause"].includes(args.command)) throw new ReaderError("paused");
			if (args.command === "pause") {
				await deps.store.pause();
				output = { schema_version: 1, ok: true, command: "pause", paused: true };
			} else if (args.command === "login") {
				await deps.login(deps.store, deps.profile, stop);
				if (stop.aborted) throw stopped();
				output = { schema_version: 1, ok: true, command: "login", message: "Sign in manually in the managed Brave Beta window. Then run slack-hf-read await-login. Leave the window open for reads. This does not prevent session expiry or account-wide revocation." };
			} else {
				// Keep the lock until attachment settles, even after cancellation.
				session = await deps.acquire(deps.store, deps.profile, args.command === "await-login");
				if (stop.aborted) throw stopped();
				if (args.command === "await-login") {
					await bounded(() => deps.verify(session!, true, stop));
					await deps.store.resume();
					output = { schema_version: 1, ok: true, command: "await-login", team_id: TEAM_ID, source: "headed_ui", session_verified: true, paused: false };
				} else output = await bounded(() => deps.read(args, session!, stop));
			}
		}
	} catch (caught) {
		error = failure(caught);
		// Persist auth loss before any browser cleanup can block or fail.
		if (lock && error.code === "auth_lost") {
			try { await deps.store.record(args.command, "auth_lost", Date.now() - started); authRecorded = true; }
			catch { error = new ReaderError("state_invalid"); }
		}
	}
	finally {
		if (abortHandler) stop.removeEventListener("abort", abortHandler);
		if (session) {
			try { await session.close(!!error); }
			catch { error ??= new ReaderError("cleanup_failed"); }
		}
		if (lock) {
			try { if (!authRecorded) await deps.store.record(args.command, error?.code ?? "success", Date.now() - started); }
			catch { error ??= new ReaderError("state_invalid"); }
			try { await lock.release(); }
			catch { error ??= new ReaderError("cleanup_failed"); }
		}
	}
	if (error) {
		deps.output({ schema_version: 1, ok: false, error: error.code, message: error.message, cause: "unknown" });
		return error.code === "cancelled" ? 130 : 1;
	}
	deps.output(output);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const profile = resolve(process.env.SLACK_HF_PROFILE_DIR ?? join(process.env.HOME!, ".pi/agent/data/slack-session"));
	const root = resolve(process.env.SLACK_HF_STATE_DIR ?? join(process.env.HOME!, ".pi/agent/data/slack-hf-read"));
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		process.exitCode = await run(process.argv.slice(2), { store: new StateStore(root), profile, root,
			acquire: acquireSession, login: startLogin, read: readUI, verify: verifyLogin, lock: acquireLock,
			output: value => console.log(JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item)) }, controller.signal);
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}
