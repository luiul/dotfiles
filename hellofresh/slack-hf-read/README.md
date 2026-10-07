# slack-hf-read

Pi reads HelloFresh Slack through a managed headed Brave Beta window. The reader uses Slack URLs and rendered UI elements. It does not capture tokens, read cookies, call the Web API, or replay credentials. PiG, Claude, and shared manual tools remain unchanged.

A dedicated profile is not proof of desktop safety. Slack can terminate all active user sessions through [Anomaly Event Response](https://slack.engineering/building-slacks-anomaly-event-response/). [Enterprise session policies](https://slack.com/help/articles/115005223763-Manage-session-duration) can also force sign-in. Local errors do not identify the cause. If reads correlate with desktop sign-outs, stop automation with `slack-hf-read pause`.

## Usage

```text
slack-hf-read status
slack-hf-read pause
slack-hf-session-login
slack-hf-read await-login
slack-hf-read doctor
slack-hf-read read 'https://hellofresh.slack.com/archives/C11111111/p1791299508307459?thread_ts=1790955451.078149&cid=C11111111' --limit 1
slack-hf-read channels --limit 20
slack-hf-read history C0BFPQSFYLR --limit 10 --after 2026-10-01 --before 2026-10-07
slack-hf-read replies C0BFPQSFYLR 1791288000.000001 --limit 10
slack-hf-read search 'in:general deployment' --limit 10
```

Pi's normal workflow is link-only. The user supplies a Slack permalink. Use `read '<url>'` rather than browsing channels, clicking thread controls, or searching for the message. The reader validates the workspace host, channel ID, message timestamp, and optional thread timestamp before browser activity. It builds a direct app URL from those IDs. A successful result includes `data.message` and the same message in `data.messages`, with `coverage.reason:"linked_message_only"`. It never substitutes another message if the exact timestamp is not rendered.

Direct permalink reading has offline coverage but has not passed the live thread-link check. The tested link returned `ui_changed`. Do not treat offline fixtures as proof of live support. Stop on this error rather than adding UI browsing or API fallback.

Limits are integers from 1 through 100. Commands reject unknown flags, invalid IDs, invalid calendar dates, duplicate flags, and missing values before browser activity. `--cursor` and `--types` are not supported. Dates filter rendered history only. The `--before` date is exclusive. Queries must be one quoted argument, at most 500 characters.

Every command emits one JSON object. Read results follow this schema:

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "history",
  "team_id": "T02AGMUUR",
  "source": "headed_ui",
  "data": {
    "messages": [{"ts": "1791288000.000001", "user": "Example User", "text": "Example message", "permalink": null}]
  },
  "coverage": {
    "complete": false,
    "reason": "rendered_messages_only",
    "returned": 1,
    "limit": 10,
    "pagination": "none",
    "order": "rendered"
  }
}
```

`channels` returns `data.channels`, each with `id` and `name`. It lists rendered joined channels, not a complete workspace directory. History, replies, and search return rendered messages only. Missing author names and timestamps are `null`. Replies include any rendered parent message. The virtualized UI can omit older messages and unrendered results. No API cursor guarantees apply. Results are not guaranteed to be chronological. Selector changes fail with `ui_changed`, not a Web API fallback.

Failure output includes `schema_version`, `ok:false`, `error`, a safe `message`, and `cause:"unknown"`. Exit codes are 0 for success, 2 for invalid arguments, 130 for cancellation, and 1 for other failures. Auth loss pauses all future reads until explicit login verification succeeds. Rate limits, network failures, missing browsers, and timeouts have distinct codes. There are no automatic retries.

## Managed window and recovery

1. Confirm Slack desktop is signed in before trying live reads. If desktop sign-outs recur, pause Pi access rather than retrying.
2. Run `slack-hf-session-login`. It starts the dedicated profile at `~/.pi/agent/data/slack-session` with debugging bound to localhost on port 9223.
3. Complete SSO manually in that window. Pi does not automate SSO.
4. Run `slack-hf-read await-login`. It observes the visible workspace for at most ten minutes. It sends no auth tests and does not reload the holder. Only successful explicit verification clears the pause.
5. Leave the window open, minimized if desired. Reads need it open. This does not guarantee freshness or override Enterprise policy.

An old window started by the previous helper is not silently adopted. Close only that dedicated window, not daily Brave or unrelated tabs. Start it again with the updated helper. Ownership is checked against the recorded process ID, process start time, exact profile path, launch flags, and localhost listener before CDP attachment. A wrong browser, workspace, or origin fails closed. There is no hidden headless mode or user-agent override.

One reader-owned Slack tab persists across successful commands. Failed reads and cancellation close that tab and disconnect CDP. The holder and unrelated tabs remain open. Normal navigation may change Slack read state. The reader does not post, react, upload, join channels, or enter message drafts. No scrolling or unbounded pagination occurs.

One owned lock covers login launch, login verification, pause, and reads. A live owner returns `lock_busy` without Slack traffic. Crash recovery checks both PID and process start time before removing a stale lock. Unknown lock ownership fails closed. A crash during lock creation or recovery can leave an unknown owner or recovery gate. In that case, automatic recovery stops. Inspect local processes and ownership before any manual cleanup. Do not delete locks manually while a process may still own them.

## Local diagnostics

`status` reads local state and process information only. It shows managed browser/profile state, last successful read, last auth loss, paused state, lock owner, and recent timing categories. It does not attach to the browser or contact Slack.

State lives at `~/.pi/agent/data/slack-hf-read`. Directories use mode 0700 and files use mode 0600. Diagnostics retain at most 100 events. They contain no queries, message bodies, tokens, cookies, or secret prefixes. Rendered credential patterns are redacted from results. Unknown failures use fixed safe messages, not raw browser errors.

## Development and verification

Use Node >= 24 for native TypeScript support. Use Node, not Bun, for CDP connections. Dependencies are already locked in `bun.lock`.

```sh
bun install
npm test
node src/main.ts status
```

The test suite uses Node's test runner, mocked sessions, sanitized fixtures, and an isolated local browser for DOM tests. It does not contact Slack. Live tests must remain bounded and require desktop sign-in first. Report each successful live check as point-in-time verification, not long-term safety. Several working days of ordinary use are needed to observe stability. Do not add synthetic polls or background keepalives.

Environment overrides: `SLACK_HF_READ_DIR` selects the wrapper's project path. `SLACK_HF_PROFILE_DIR` selects the dedicated profile. `SLACK_HF_STATE_DIR` selects the private state and lock directory. Override paths must remain private and owned by the current user.
