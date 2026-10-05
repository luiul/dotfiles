/**
 * Slack MCP automatic re-auth (kicked-out recovery) for the HelloFresh workspace.
 *
 * The slack MCP server (korotovsky/slack-mcp-server via the slack-mcp-server-hf
 * wrapper) borrows the Slack desktop app's live web session. Slack Enterprise
 * Grid periodically kills that session server-side ("session forking" anomaly
 * detection), after which every Slack tool call fails with invalid_auth.
 *
 * This extension makes recovery automatic, with zero manual steps in the common
 * case. On a Slack auth failure it:
 *   1. Probes for a FRESH session via `slack-hf-session --check` (re-extracts
 *      xoxc/xoxd from the desktop app and validates with Slack's auth.test).
 *   2. Fresh session valid -> kills the dead slack-mcp-server process so the
 *      next call lazily relaunches the wrapper with the fresh session, and
 *      appends a "retry now" note to the tool result so the model re-issues
 *      the call instead of reporting failure.
 *   3. Fresh session also invalid -> the desktop app itself was signed out
 *      (SSO/MFA, cannot be scripted). Nothing is killed (avoids a pointless
 *      relaunch and the adapter's 60s launch-failure backoff); the result
 *      gets a precise "sign back into Slack.app, then ask to retry" note and
 *      further probes cool down for 45s. Once the user signs back in, the next
 *      failure probes successfully and the kill+retry path recovers by itself.
 *
 * Also covers the launch-failure shape (server down + dead token at boot, or
 * a failed relaunch): the tool result then carries details.error of
 * server_unavailable/not_connected/init_failed instead of an invalid_auth
 * body, and gets the same probe-driven guidance.
 *
 * Why a tool_result hook and not the MCP adapter's own reconnect: an
 * application-level invalid_auth arrives as a normal (isError) tool result,
 * which the adapter treats as a successful MCP call -- withSessionRecovery
 * only reconnects on thrown transport errors. And the adapter cannot know
 * that killing the process is the fix, so it would keep the dead server alive
 * until the 10-minute idle shutdown.
 *
 * Loop safety: at most one kill per KILL_GRACE_MS window, at most
 * MAX_KILLS_PER_WINDOW kills per KILL_WINDOW_MS, and failed probes cool down
 * FAILED_PROBE_COOLDOWN_MS. Concurrent probes share one in-flight exec.
 * `/slack-reauth` forces the probe+restart on demand.
 */

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// Direct slack tools are exposed as slack_<tool> (or mcp__slack__<tool>);
// the adapter also tags result details with server: "slack". The mcp gateway
// tool is covered for calls carrying server: "slack" in their input.
const SLACK_TOOL_NAME = /^(?:mcp__slack__|slack_)/;
// Slack API auth error codes, as embedded in the server's error text.
const SLACK_AUTH_ERROR = /\b(?:invalid_auth|not_authed|account_inactive|token_revoked|token_expired)\b/i;
// Adapter-level failure kinds meaning the server isn't running at all.
const LAUNCH_FAILURES = new Set(["server_unavailable", "not_connected", "init_failed", "auth_required"]);
// Same, as it appears in result TEXT when the failure arrives without
// structured details (mcp gateway tool results carry no details.error).
const SLACK_LAUNCH_TEXT = /failed to connect to "slack"|server "slack" (?:is )?not available|MCP server "slack" not available/i;
const FAILURE_WORDS = /error|failed|not available|not connected/i;
// pkill -f pattern: the node launcher and the Go child, never the wrapper
// script (slack-mcp-server-hf), which may be mid-extraction for a new launch.
const SERVER_PROCESS_PATTERN = "slack-mcp-server(/bin/index\\.js|-darwin-arm64)";

const PROBE_TIMEOUT_MS = 20_000;
const FAILED_PROBE_COOLDOWN_MS = 45_000;
const KILL_GRACE_MS = 30_000;
const MAX_KILLS_PER_WINDOW = 3;
const KILL_WINDOW_MS = 15 * 60_000;
// After a sign-out, Slack's anomaly detection is hair-triggered: a session
// that validated moments ago can be killed by the very next replay (observed
// 2026-10-05: fresh session killed ~3s after validating). When a probe fails
// this soon after a valid one, retries would just keep killing fresh
// sessions, so the guidance changes to "sign in and cool off".
const HOT_DETECTOR_WINDOW_MS = 15 * 60_000;

const TAG = "[slack-auth-recovery]";

let probeInFlight: Promise<boolean> | undefined;
let lastKillAt = 0;
let lastFailedProbeAt = 0;
let lastValidProbeAt = 0;
let killTimes: number[] = [];
let helperMissingWarned = false;

function resultText(event: ToolResultEvent): string {
	return event.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function withNote(event: ToolResultEvent, text: string) {
	return { content: [...event.content, { type: "text" as const, text: `${TAG} ${text}` }] };
}

const SIGN_IN_NOTE =
	"Slack invalidated this session server-side and the Slack desktop app currently holds no valid session, so automatic re-auth is not possible (sign-in is SSO/MFA gated). Do NOT retry this call in a loop. Tell the user to sign back into Slack.app, and mention that once signed in they can simply ask you to retry: the next Slack call automatically picks up the fresh session.";

const HOT_SIGN_IN_NOTE =
	"Slack invalidated this session server-side, and a session that validated moments ago was killed too: Slack's anomaly detection is currently rejecting every borrowed session (normal for a while after a sign-out). Do NOT retry this call: each retry relaunches the connector and risks killing the next fresh session as well. Tell the user to sign back into Slack.app, let it run normally for about 15 minutes, and only then ask you to retry.";

function signInNote(): string {
	return Date.now() - lastValidProbeAt < HOT_DETECTOR_WINDOW_MS ? HOT_SIGN_IN_NOTE : SIGN_IN_NOTE;
}

export default function (pi: ExtensionAPI) {
	// True when a freshly extracted session validates against Slack right now.
	// Concurrent callers share one probe; a missing/broken helper counts as
	// invalid (with a one-time warning) rather than crashing the hook chain.
	async function probeFreshSession(ctx: ExtensionContext): Promise<boolean> {
		probeInFlight ??= (async () => {
			try {
				const res = await pi.exec("slack-hf-session", ["--check"], { timeout: PROBE_TIMEOUT_MS });
				return res.code === 0;
			} catch {
				if (!helperMissingWarned) {
					helperMissingWarned = true;
					ctx.ui.notify(`${TAG} slack-hf-session not executable; auto re-auth disabled`, "error");
				}
				return false;
			} finally {
				probeInFlight = undefined;
			}
		})();
		return probeInFlight;
	}

	// Kill the dead server so the adapter's lazy connect relaunches the
	// wrapper (fresh extraction) on the next call. pkill exits 1 when nothing
	// matched; both outcomes are fine, so errors are swallowed.
	async function killServer(): Promise<void> {
		try {
			await pi.exec("pkill", ["-f", SERVER_PROCESS_PATTERN], { timeout: 10_000 });
		} catch {
			// Best effort.
		}
	}

	async function handle(event: ToolResultEvent, ctx: ExtensionContext) {
		const details = (event as { details?: { error?: unknown; server?: unknown } }).details;
		const detailError = typeof details?.error === "string" ? details.error : undefined;
		const detailServer = typeof details?.server === "string" ? details.server : undefined;
		const text = resultText(event);
		// The mcp gateway tool is the common path to slack (its lazy server has
		// no declared direct tools before first connect). Gateway results carry
		// no details.error and report failures as plain text mentioning "slack".
		const viaGateway =
			event.toolName === "mcp" &&
			(event.input?.server === "slack" ||
				event.input?.connect === "slack" ||
				SLACK_TOOL_NAME.test(String(event.input?.tool ?? "")) ||
				/\bslack\b/i.test(text));
		if (!SLACK_TOOL_NAME.test(event.toolName) && detailServer !== "slack" && !viaGateway) return;

		const hasAuthError = SLACK_AUTH_ERROR.test(text);
		const launchFailure = (detailError !== undefined && LAUNCH_FAILURES.has(detailError)) || SLACK_LAUNCH_TEXT.test(text);
		const mentionsFailure = event.isError || detailError !== undefined || FAILURE_WORDS.test(text);
		// The short-text guard keeps an innocent "invalid_auth" mention inside a
		// long, successful conversation dump from triggering a needless probe.
		if (!launchFailure && !(hasAuthError && (mentionsFailure || text.length < 500))) return;

		// A kill just happened: sibling calls from the same batch that were
		// still in flight on the dead server land here. No new probe; the note
		// covers both "retry now" and "the retry itself failed" cases.
		const sinceKillMs = Date.now() - lastKillAt;
		if (sinceKillMs < KILL_GRACE_MS) {
			return withNote(
				event,
				`A fresh Slack session was installed ${Math.round(sinceKillMs / 1000)}s ago. If you have not retried since then, retry this call once now. If this call already ran against the refreshed session and still failed, stop retrying and tell the user to sign back into Slack.app.`,
			);
		}

		// A recent probe found no valid session: the user has been told to sign
		// back in; don't re-probe (and re-notify) on every failing call.
		if (Date.now() - lastFailedProbeAt < FAILED_PROBE_COOLDOWN_MS) {
			return withNote(event, signInNote());
		}

		// Cap kills so a pathological loop (Slack killing every fresh session
		// within seconds) degrades to a clear user message instead of churn.
		killTimes = killTimes.filter((t) => Date.now() - t < KILL_WINDOW_MS);
		if (killTimes.length >= MAX_KILLS_PER_WINDOW) {
			return withNote(
				event,
				`Automatic re-auth already ran ${MAX_KILLS_PER_WINDOW} times in the last ${KILL_WINDOW_MS / 60_000} minutes and Slack keeps rejecting the session. Stop retrying and tell the user to sign back into Slack.app (and to check for a 'suspicious activity' email from Slack).`,
			);
		}

		ctx.ui.notify(`${TAG} Slack session rejected, checking Slack.app for a fresh session...`, "info");
		const fresh = await probeFreshSession(ctx);

		if (!fresh) {
			lastFailedProbeAt = Date.now();
			ctx.ui.notify(`${TAG} no valid session in Slack.app. Sign back into Slack.app, then retry.`, "error");
			return withNote(event, signInNote());
		}

		lastValidProbeAt = Date.now();

		if (launchFailure) {
			// No live server to kill (it never came up or already exited). The
			// adapter's 60s launch-failure backoff may still gate the retry.
			return withNote(
				event,
				"A valid fresh Slack session exists in the desktop app now. Retry this call; if it reports a recent launch failure ('failed Xs ago'), wait about 60 seconds and retry once more.",
			);
		}

		await killServer();
		lastKillAt = Date.now();
		killTimes.push(lastKillAt);
		ctx.ui.notify(`${TAG} fresh session found, connector restarted. Retry is safe now.`, "info");
		return withNote(
			event,
			"This call failed only because Slack had invalidated the previous session token. A fresh session was extracted from the Slack desktop app and the connector was restarted automatically. No user action is needed: retry the same call once now.",
		);
	}

	pi.on("tool_result", async (event, ctx) => {
		try {
			return await handle(event, ctx);
		} catch {
			// Never break the shared tool_result hook chain.
			return undefined;
		}
	});

	pi.registerCommand("slack-reauth", {
		description: "Re-extract the Slack session from Slack.app and restart the Slack MCP connector",
		handler: async (_args, ctx) => {
			if (await probeFreshSession(ctx)) {
				await killServer();
				lastValidProbeAt = Date.now();
				lastKillAt = Date.now();
				killTimes.push(lastKillAt);
				ctx.ui.notify(`${TAG} connector restarted with a fresh session; the next Slack call uses it.`, "info");
			} else {
				lastFailedProbeAt = Date.now();
				ctx.ui.notify(`${TAG} no valid session in Slack.app. Sign back into Slack.app first.`, "error");
			}
		},
	});
}
