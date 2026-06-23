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
 * This extension checks the SSO session on startup and refreshes it by running
 * `aws sso login --profile <profile>` (which opens the browser) before the
 * session is used. It also exposes a manual `/sso` command to refresh on demand.
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

async function ensureSession(ctx: ExtensionContext): Promise<void> {
	if (await sessionValid()) return;
	await login(ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		// Only check on a fresh process start, not on every /new or /resume.
		if (event.reason !== "startup") return;
		await ensureSession(ctx);
	});

	pi.registerCommand("sso", {
		description: "Refresh the AWS SSO session for Bedrock",
		handler: async (_args, ctx) => {
			if (await sessionValid()) {
				ctx.ui.notify(`AWS SSO session already valid (${PROFILE})`, "info");
				return;
			}
			await login(ctx);
		},
	});
}
