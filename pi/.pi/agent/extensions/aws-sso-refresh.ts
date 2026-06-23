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

// True when the current SSO credentials can call AWS.
async function sessionValid(): Promise<boolean> {
	try {
		await execFileAsync("aws", ["sts", "get-caller-identity", "--profile", PROFILE], {
			timeout: 15_000,
		});
		return true;
	} catch {
		return false;
	}
}

async function login(ctx: ExtensionContext): Promise<boolean> {
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
