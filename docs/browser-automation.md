# Browser Automation

Pi agents use the already open Google Chrome through the Playwriter extension and CLI, including for Slack.
Chrome is solely for agents, not Luis's personal browsing.
Use one connected browser, with task-specific sessions and tabs.
Do not start another browser, profile, or dedicated Slack window.

## Components

| Component | What | Where |
|---|---|---|
| Google Chrome | The only agent browser | `/Applications/Google Chrome.app` (`brew install --cask google-chrome`) |
| Chrome profile | The existing connected profile, discovered at runtime | `playwriter browser list` |
| Playwriter extension | Bridges the connected Chrome to the CLI | [Chrome Web Store](https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe) |
| Playwriter CLI | Sessions and relay control | `/opt/homebrew/bin/playwriter` (`npm i -g playwriter`) |
| Relay daemon | WebSocket bridge between CLI and extension | `localhost:19988`, auto-starts on first CLI command |
| Skill | Full CLI reference, loaded on demand | `~/.pi/agent/skills/playwriter/SKILL.md`, context-mode source `playwriter-skill` |
| Pi MCP config | No Playwright or Playwriter entry | Live file `~/.pi/agent/mcp-adapter.json`; dotfiles copy is a snapshot |

## Decisions and why

- One browser path: use Playwriter for all agent browser work, including Slack. Separate browser paths caused wrong-instance and profile-lock failures.
- Chrome over Brave Beta: Brave Beta kept closing and crashed on launch on 2026-11-06. A reinstall did not fix it.
- Existing browser over fresh instance: reuse its current sign-in without copying credentials or setting up another profile.
- CLI plus skill, not MCP: Playwriter's MCP `execute` tool description is 53KB. Load the CLI reference only when needed.
- Profile and account are runtime facts, not fixed settings. Do not hardcode a profile name, account, or browser key.
- Browser sessions isolate `state`, not tabs or authentication. Other workers share the browser, so each task owns its session and pages.
- No Playwright MCP, direct CDP reader, headless browser, cloud browser, or second automation profile for this workflow.

## Usage

```bash
playwriter browser list                  # must show exactly one connected Chrome
playwriter session new --tab-group browse # use the session ID printed by this command
session=20                              # example only, replace with your own session ID
playwriter -s "$session" -e 'state.page = await context.newPage(); await state.page.goto("https://example.com", { waitUntil: "domcontentloaded" }); console.log(state.page.url())'
playwriter -s "$session" -e 'console.log(await snapshot({ page: state.page }))'
playwriter -s "$session" -e 'if (state.page && !state.page.isClosed()) await state.page.close()'
playwriter session delete "$session"
```

- Run `playwriter browser list` before creating a session. Continue only when it shows exactly one connected Chrome.
- If it shows zero or multiple browsers, stop and report the result. Do not guess a key or launch another browser.
- Create your own task-specific session and pages with `context.newPage()`. Record page ownership in your session's `state`.
- Never reuse another worker's session or the shared default `page`. Do not claim an existing tab or `about:blank` page without handoff.
- Existing tabs need explicit ownership handoff and Playwriter access before use. Agent-created pages do not need a manual extension-icon click.
- Use `state.page` explicitly in helpers. Observe the current URL and rendered DOM after each action.
- Save large snapshots to a task-owned artifact and process them through context-mode. Do not dump unrelated tab content.
- Close only pages you created, then delete only your own session. Do not close the browser, context, windows, or other workers' tabs.
- Never call `browser.close()` or `context.close()`, clear shared browser state, or stop the shared relay.

## Slack: read-only DOM access

**Pi reads only.** Use a task-owned page in the same connected Chrome, not a dedicated Slack profile or window.
Reuse the existing sign-in. Do not run login or verification before each read or schedule recurring manual sign-in.
Normal navigation may change Slack read state.

- Never post, react, upload, change membership, or enter message drafts.
- Read rendered DOM only. Do not read or copy cookies, tokens, browser storage, hidden application state, or network request/response bodies.
- Do not use Slack APIs, authenticated fetches, API replay, credential replay, or another client as a workaround. General skill examples do not override these rules.
- Default scope is only the supplied exact permalink. Read its message only, not nearby history, its parent, or replies unless requested.
- The Enterprise workspace host is `https://hellofreshgroup.enterprise.slack.com/` (older permalinks may still use `https://hellofresh.slack.com/`). An `/archives/<channel>/p<digits>` URL opens a desktop-app redirect page (`Redirecting… | Slack`); open `https://hellofreshgroup.enterprise.slack.com/messages/<channel>/p<digits>` (preserving any `?thread_ts=...&cid=...` query) and wait for `location.hostname === "app.slack.com"` before reading message containers.
- Verify workspace and channel from the rendered UI. Match the linked timestamp against structural DOM evidence, such as message attributes or timestamp permalinks.
- Convert a permalink's `p<digits>` timestamp by inserting a decimal before its last six digits. Displayed clock text alone is not exact-message proof.
- An explicit thread request permits its parent and replies. Verify the parent timestamp, each reply timestamp, and the rendered reply count.
- Count one parent plus unique replies. Do not count the linked reply twice or treat a visible subset as a complete thread.
- An explicit channel request permits that channel's accessible history and replies. Apply requested date and author filters to each returned message.
- Do not discover other channels or search unrelated content. Bound scrolling and wait time. Report unread threads, gaps, missing identity, and partial coverage.
- Claim a complete thread only when structural timestamps and the visible reply count match the collected parent and replies. Prove channel boundaries and continuity before claiming complete channel coverage.
- If the exact message is missing or structure is unclear, report that it was not verified. Do not substitute nearby content.
- On auth loss, sign-in redirection, access denial, rate limiting, or suspected revocation, stop and report once. No retry loops, repeated tabs, sign-in windows, or client switching.

A separate profile does not protect sessions from [Slack Anomaly Event Response](https://slack.engineering/building-slacks-anomaly-event-response/) or [Enterprise session policy](https://slack.com/help/articles/115005223763-Manage-session-duration).
Keeping a window open or waiting a fixed cooldown does not bypass policy.
If reads correlate with desktop sign-outs, stop automation. Report the cause as unknown without stronger evidence.
Do not add keepalives or synthetic health polling.

## Historical Slack reader

[slack-reader](https://github.com/luiul/slack-reader) remains installed for now, with its compatibility shims.
It is retired from Pi's default workflow and is not a fallback.
Do not run `slack-reader login` or `slack-reader await-login`, clear its persisted auth pause, or remove its owned lock.
This guidance does not remove the old reader, change its code, or authorize cleanup of another worker's browser.

## Verify and repair

- If no extension browser is connected, report it. Do not launch another Chrome profile or repeatedly open tabs.
- A stale task session may be reset with `playwriter session reset <session>`, but never reset another worker's session.
- Browser keys can change. Discover the current browser with `playwriter browser list`; do not save a key in docs or scripts.
- Extension repair must target the actual connected profile, with approval. Do not infer extension status from personal or work account labels.
- Browser setup checks do not prove Slack access or complete coverage. Slack verification needs the scoped DOM checks above.
