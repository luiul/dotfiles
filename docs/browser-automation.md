# Browser Automation

Use the Playwriter CLI and its extension with the existing Google Chrome work profile, `luis.aceituno@hellofresh.com`. Do not start a separate browser or profile for Playwriter. Slack reads use the separate reader below.

## Components

| Component | What | Where |
|---|---|---|
| Google Chrome | The only agent browser | `/Applications/Google Chrome.app` (`brew install --cask google-chrome`) |
| Work Chrome profile | "hellofresh.com", `luis.aceituno@hellofresh.com` | Existing Chrome profile `Profile 1` |
| Playwriter extension | [Chrome Web Store](https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe) | Installed in the work profile |
| playwriter CLI | npm global package, 0.9.0. Sessions, relay control | `/opt/homebrew/bin/playwriter` (`npm i -g playwriter`) |
| Relay daemon | WebSocket bridge between CLI and extension | `localhost:19988`, auto-starts on first CLI command |
| Skill | Full CLI reference, loaded on demand | `~/pi-skills/pi-native/playwriter/SKILL.md`, indexed in context-mode as source `playwriter-skill` |
| pi MCP config | Only `kb`. No `playwright`, no `playwriter` entry | Live file `~/.pi/agent/mcp-adapter.json`; dotfiles copy is a snapshot |

## Decisions and why

- One path: Luis asked on 2026-11-06 for a single way to use the browser. Before that there were five surfaces (two Brave Beta profiles, stable Brave, Playwright MCP, playwriter), which caused wrong-instance and profile-lock failures.
- Chrome over Brave Beta: Brave Beta (157.1.100.49) kept closing and crashed on launch (three SIGTRAP reports on 2026-11-06). A `brew reinstall` did not change the symptom.
- Real browser over fresh instance: a fresh Playwright browser has no logins and gets flagged by bot detection. Since Chrome 136, `--remote-debugging-port` is refused on the default profile, so an extension bridge is the practical way to drive a logged-in browser.
- playwriter over alternatives: full Playwright API, active maintenance, works with MV3. Browser MCP is unmaintained and the other options are immature or bundle their own agent loop.
- CLI plus skill, not MCP: playwriter's MCP `execute` tool description is 53.6KB (about 13k tokens). The CLI with the on-demand skill costs about 30 standing tokens.
- Profile: use the existing HelloFresh work profile. Do not use the personal profile for Playwriter.
- Playwright MCP is removed from the live config. For a clean room with no logins, use `playwriter session new --browser headless` (headless Chrome for Testing, installed with `playwriter browser install`).

## Slack reader, a separate browser path

Slack reads use [slack-reader](https://github.com/luiul/slack-reader), not Playwriter's shared browser tabs or the retired source copy in `hellofresh/slack-hf-read`.
The live `slack-hf-read` and `slack-hf-session-login` commands are compatibility shims into `~/projects/personal/slack-reader`.

- General browser automation: Playwriter CLI, installed version 0.9.0, with Google Chrome.
- Slack: Playwright Core in Node, with the dedicated `~/.pi/agent/data/slack-session` profile and `127.0.0.1:9223` debugging endpoint.
- Do not share profiles, copy credentials, or open Slack tabs in Playwriter as a reader fallback.
- Pi reads only user-supplied permalinks. Normal reads use `slack-reader read '<url>' --limit 1`.
- `await-login` verifies manual recovery and clears the reader's safety pause. It is not needed before every read and closes the managed window by default.
- This separation preserves Slack's owned lock, auth pause, exact-message checks, and bounded window cleanup. Playwriter remains the default for other browser work.

Chrome's [non-default profile requirement](https://developer.chrome.com/blog/remote-debugging-port) permits direct debugging of a dedicated profile. It does not force this reader to use an extension bridge.
Neither Playwriter nor a dedicated profile guarantees protection from Slack Enterprise session revocation.

## Usage

```bash
playwriter browser list                     # must show one Chrome on the work profile
playwriter session new --tab-group <word>   # prints a session id
playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
playwriter -s 1 -e 'console.log(await snapshot({ page: state.page }))'   # a11y tree with aria-ref handles
playwriter session delete 1                 # when done
```

- Agent-created tabs (`context.newPage()`) run in the real Chrome profile: cookies and logins apply. No icon click needed.
- Pre-existing tabs need one manual extension-icon click each.
- Continue only when exactly one connected Chrome uses the work profile. If it is absent or ambiguous, stop and report it. Do not guess a key or launch another browser.
- Pipe large snapshots through context-mode (`ctx_execute`/`ctx_search`, source `playwriter-skill` for docs).
- Always close pages you opened and delete your own session. Other sessions belong to other agents.

## Verify and repair

- Health check: `playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); console.log(await state.page.title())'` prints `Example Domain`.
- "Waiting for extension to connect..." or "No browsers detected": report the missing connection. Do not start another browser or profile.
- Stale session after a browser restart: `playwriter session reset <id>`, or delete it and create a new one.
- "No current window" from `newPage`: Chrome has no window. Open one.
- Reinstall the extension: open https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe in the affected profile, click Add to Chrome, and confirm "Add extension".
- Browser keys (`install:Chrome:...`) change when the extension is reinstalled. Never hardcode them.

## Not done, deliberately

- No extension in other browsers.
- No Playwright MCP.
- No Chrome DevTools MCP. Revisit if perf debugging becomes a need.
- No token-efficient browser CLIs. context-mode already covers the token problem.
