/**
 * AWS SSO session auto-refresh for pi (mirrors Claude Code's `awsAuthRefresh`).
 *
 * Pi's amazon-bedrock provider relies on the ambient AWS credential chain
 * (here, `AWS_PROFILE=sso-bedrock`). SSO sessions expire after a few hours,
 * after which every model call fails with "The SSO session ... has expired".
 *
 * This validates the session on startup and before every agent turn
 * (`before_agent_start`, which pi awaits before the model is called), so an
 * expired session is refreshed via `aws sso login` (opens the browser) before
 * the next prompt instead of failing the call. The pre-turn check is throttled
 * (VALIDATE_TTL_MS) and concurrent refreshes share one login. `/sso` forces a
 * refresh on demand.
 */

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// Profile pi authenticates Bedrock with (falls back to the sso-bedrock profile).
const PROFILE = process.env.AWS_PROFILE || "sso-bedrock";
// Max wait for the interactive browser login.
const LOGIN_TIMEOUT_MS = 120_000;
// Skip the pre-turn check if validated this recently.
const VALIDATE_TTL_MS = 5 * 60_000;

let lastValidAt = 0;
let inFlight: Promise<boolean> | undefined;

// Cross-PROCESS guard: separate `pi`/`pi -p` invocations (e.g. many
// concurrent probes from sync-enabled-models.sh, or several terminal tabs
// starting around the same time) don't share the in-process `inFlight`
// dedup above, since each is a fresh Node process with its own module state.
// Without this, several of them can independently decide the session is
// invalid (a real observed failure mode: concurrent `aws sts
// get-caller-identity` calls transiently erroring under contention, not
// actual expiry) and each launch its own `aws sso login` -- multiple
// concurrent browser/device-code flows. This lockfile makes every process
// but the first one that observes a recent login attempt skip straight to
// re-checking validity instead of launching another login.
const LOGIN_LOCK_PATH = join(tmpdir(), `pi-aws-sso-login-${PROFILE}.lock`);
const LOGIN_LOCK_TTL_MS = 30_000;

function recentLoginInFlightElsewhere(): boolean {
	try {
		const ts = Number(readFileSync(LOGIN_LOCK_PATH, "utf8"));
		return Date.now() - ts < LOGIN_LOCK_TTL_MS;
	} catch {
		return false;
	}
}

function claimLoginLock(): void {
	try {
		writeFileSync(LOGIN_LOCK_PATH, String(Date.now()));
	} catch {
		// Best-effort; if we can't write the lock, worst case we don't dedup
		// across processes this one time.
	}
}

function releaseLoginLock(): void {
	try {
		unlinkSync(LOGIN_LOCK_PATH);
	} catch {
		// Already gone/never created -- fine.
	}
}

// True when the current SSO credentials can call AWS. Retries once on
// failure: under concurrent process starts (e.g. many `pi -p` invocations at
// once, as sync-enabled-models.sh does when probing), `aws sts
// get-caller-identity` can transiently fail from SSO-cache-file/API
// contention even though the session is genuinely valid, which previously
// caused several processes to each independently decide "expired" and spawn
// their own `aws sso login` -- a real incident, not auth expiry. A short
// retry absorbs that transient failure before we conclude the session is
// actually invalid.
async function sessionValid(): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await execFileAsync("aws", ["sts", "get-caller-identity", "--profile", PROFILE], {
				timeout: 15_000,
			});
			return true;
		} catch {
			if (attempt === 0) await new Promise((r) => setTimeout(r, 1_000));
		}
	}
	return false;
}

async function login(ctx: ExtensionContext): Promise<boolean> {
	// Another process just started (or finished) its own login very recently:
	// give it a moment to land rather than piling on a second browser flow,
	// then re-check validity (it likely already fixed things for everyone,
	// since all processes share the same underlying SSO session/cache).
	if (recentLoginInFlightElsewhere()) {
		await new Promise((r) => setTimeout(r, 3_000));
		if (await sessionValid()) return true;
	}

	claimLoginLock();
	ctx.ui.notify(`AWS SSO expired - opening browser to log in (${PROFILE})...`, "info");
	try {
		await execFileAsync("aws", ["sso", "login", "--profile", PROFILE], {
			timeout: LOGIN_TIMEOUT_MS,
		});
		ctx.ui.notify(`AWS SSO session refreshed (${PROFILE})`, "info");
		return true;
	} catch {
		ctx.ui.notify(`AWS SSO login failed - run 'aws sso login --profile ${PROFILE}' manually`, "error");
		return false;
	} finally {
		releaseLoginLock();
	}
}

// Ensure a usable session, refreshing if needed. `force` bypasses the TTL.
// Returns whether the session is usable afterward.
async function ensureSession(ctx: ExtensionContext, force = false): Promise<boolean> {
	if (!force && Date.now() - lastValidAt < VALIDATE_TTL_MS) return true;
	inFlight ??= (async () => {
		try {
			const ok = (await sessionValid()) || (await login(ctx));
			if (ok) lastValidAt = Date.now();
			return ok;
		} finally {
			inFlight = undefined;
		}
	})();
	return inFlight;
}

export default function (pi: ExtensionAPI) {
	// Fresh process start only, not every /new or /resume.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup") await ensureSession(ctx, true);
	});

	// Refresh before each turn so a mid-session expiry never reaches the model.
	pi.on("before_agent_start", async (_event, ctx) => {
		await ensureSession(ctx);
	});

	pi.registerCommand("sso", {
		description: "Refresh the AWS SSO session for Bedrock",
		handler: async (_args, ctx) => {
			if (await ensureSession(ctx, true)) ctx.ui.notify(`AWS SSO session valid (${PROFILE})`, "info");
		},
	});
}
