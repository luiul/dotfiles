/**
 * AWS SSO session auto-refresh for pi (mirrors Claude Code's `awsAuthRefresh`).
 *
 * Pi's amazon-bedrock provider relies on the ambient AWS credential chain
 * (here, `AWS_PROFILE=sso-bedrock`). SSO sessions expire after a few hours,
 * after which every model call fails with:
 *
 *   The SSO session associated with this profile has expired. To refresh this
 *   SSO session run aws sso login with the corresponding profile.
 *
 * This extension validates the SSO session on startup AND before every agent
 * turn (`before_agent_start`, which pi awaits before the model is called), so a
 * session that expires mid-session is refreshed before the next prompt rather
 * than failing the model call. When invalid it runs `aws sso login --profile
 * <profile>` (which opens the browser). It also exposes a manual `/sso`
 * command to refresh on demand.
 *
 * The pre-turn validation is throttled (see VALIDATE_TTL_MS) so it does not add
 * an `sts` round-trip to every single prompt, and concurrent refreshes share a
 * single in-flight login.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// Profile pi authenticates Bedrock with. Falls back to AWS_PROFILE, then the
// known sso-bedrock profile from ~/.aws/config.
const PROFILE = process.env.AWS_PROFILE || "sso-bedrock";

// How long to wait for the interactive browser login to complete.
const LOGIN_TIMEOUT_MS = 120_000;

// Re-validate the session at most this often on the pre-turn check. SSO
// sessions last hours, so a short TTL catches expiry without probing AWS on
// every prompt.
const VALIDATE_TTL_MS = 5 * 60_000;

// Timestamp (ms) of the last confirmed-valid session, and a shared promise so
// overlapping ensureSession calls do not trigger duplicate logins.
let lastValidAt = 0;
let inFlight: Promise<void> | undefined;

// Returns true when the current SSO credentials can call AWS, false otherwise.
async function sessionValid(): Promise<boolean> {
	try {
		await execFileAsync(
			"aws",
			["sts", "get-caller-identity", "--profile", PROFILE, "--output", "json"],
			{ timeout: 15_000 },
		);
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
		ctx.ui.notify(
			`AWS SSO login failed - run 'aws sso login --profile ${PROFILE}' manually`,
			"error",
		);
		return false;
	}
}

// Ensure a usable SSO session. `force` bypasses the TTL throttle (used at
// startup and by the manual /sso command).
async function ensureSession(ctx: ExtensionContext, force = false): Promise<void> {
	if (!force && Date.now() - lastValidAt < VALIDATE_TTL_MS) return;
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			if (await sessionValid()) {
				lastValidAt = Date.now();
				return;
			}
			if (await login(ctx)) lastValidAt = Date.now();
		} finally {
			inFlight = undefined;
		}
	})();
	return inFlight;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		// Only check on a fresh process start, not on every /new or /resume.
		if (event.reason !== "startup") return;
		await ensureSession(ctx, true);
	});

	// Validate before each agent turn so a session that expired mid-session is
	// refreshed before the model call that would otherwise fail. Throttled by
	// VALIDATE_TTL_MS inside ensureSession.
	pi.on("before_agent_start", async (_event, ctx) => {
		await ensureSession(ctx);
	});

	pi.registerCommand("sso", {
		description: "Refresh the AWS SSO session for Bedrock",
		handler: async (_args, ctx) => {
			if (await sessionValid()) {
				lastValidAt = Date.now();
				ctx.ui.notify(`AWS SSO session already valid (${PROFILE})`, "info");
				return;
			}
			await ensureSession(ctx, true);
		},
	});
}
