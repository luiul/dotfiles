# Browser Automation

Setup for letting Pi agents drive a real browser with logged-in sessions. General browser automation uses the playwriter CLI with Google Chrome through the Playwriter extension. Switched from Brave Beta on 2026-11-06 because Brave Beta kept closing. No Playwright MCP or second general automation profile is allowed. Slack reads use the separate managed Chrome path below.

## Components

| Component | What | Where |
|---|---|---|
| Google Chrome | The only agent browser | `/Applications/Google Chrome.app` (`brew install --cask google-chrome`) |
| Chrome profile | General automation: "Your Chrome", personal Google account. Holds the extension | `--profile-directory=Default`, `~/Library/Application Support/Google/Chrome/Default` |
| playwriter extension | Web Store install, id `jfeammnjpkecdekppnclgkkffahnhfhe`, installed 2026-11-06 | Chrome profile `Default` only |
| playwriter CLI | npm global package, 0.9.0. Sessions, relay control | `/opt/homebrew/bin/playwriter` (`npm i -g playwriter`) |
| Relay daemon | WebSocket bridge between CLI and extension | `localhost:19988`, auto-starts on first CLI command |
| Skill | Full CLI reference, loaded on demand | `~/pi-skills/pi-native/playwriter/SKILL.md`, indexed in context-mode as source `playwriter-skill` |
| pi MCP config | Only `kb`. No `playwright`, no `playwriter` entry | Live file `~/.pi/agent/mcp-adapter.json`; dotfiles copy is a snapshot |

## Decisions and why

- One general automation path: Luis asked on 2026-11-06 for a single way to use the browser. Before that there were five surfaces (two Brave Beta profiles, stable Brave, Playwright MCP, playwriter), which caused wrong-instance and profile-lock failures.
- Chrome over Brave Beta: Brave Beta (157.1.100.49) kept closing and crashed on launch (three SIGTRAP reports on 2026-11-06). A `brew reinstall` did not change the symptom.
- Real browser over fresh instance: a fresh Playwright browser has no logins and gets flagged by bot detection. Since Chrome 136, `--remote-debugging-port` is refused on the default profile, so an extension bridge is the practical way to drive a logged-in browser.
- playwriter over alternatives: full Playwright API, active maintenance, works with MV3. Browser MCP is unmaintained and the other options are immature or bundle their own agent loop.
- CLI plus skill, not MCP: playwriter's MCP `execute` tool description is 53.6KB (about 13k tokens). The CLI with the on-demand skill costs about 30 standing tokens.
- Profile: the personal "Your Chrome" profile (aceitunosoriano@gmail.com). The HelloFresh work profile ("Profile 1") has no extension on purpose. Work accounts are not reachable by agents.
- Logins are per profile. On 2026-11-06 this profile had a Google session but no GitHub or LinkedIn login.
- Playwright MCP is removed from the live config. For a clean room with no logins, use `playwriter session new --browser headless` (headless Chrome for Testing, installed with `playwriter browser install`).

## Slack reader, a separate browser path

Slack reads use [slack-reader](https://github.com/luiul/slack-reader), not Playwriter's shared browser tabs or the retired source copy in `hellofresh/slack-hf-read`.
The live `slack-hf-read` and `slack-hf-session-login` commands are compatibility shims into `~/projects/personal/slack-reader`.

- General browser automation: Playwriter CLI, installed version 0.9.0, with Google Chrome.
- Slack: the Go `slack-reader` CLI reads rendered UI only through CDP. It uses `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Slack has a fresh dedicated `~/.pi/agent/data/slack-chrome-session` profile and loopback CDP endpoint `127.0.0.1:9223`.
- The existing `~/.pi/agent/data/slack-reader` state, owned lock, and auth pause remain shared across reader commands.
- Do not copy or reuse the Brave profile or standard Chrome user data. Do not share profiles, copy credentials, or use Playwriter's shared tabs for Slack reads.
- Pi reads only the supplied permalink unless the user explicitly requests broader scope. Normal reads use `slack-reader read '<url>' --scope message`.
- An explicit thread request uses `slack-reader read '<url>' --scope thread`. The CLI defaults to thread scope, so always pass the scope. `--limit 1` does not select message scope.
- Migration does not clear the auth pause or sign in. Run `slack-reader login` for manual SSO, then `slack-reader await-login` to verify sign-in and clear the pause.
- `await-login` is not needed before every later read and closes the managed window by default.
- This separation preserves Slack's owned lock, auth pause, exact-message checks, and bounded window cleanup. Playwriter remains the default for other browser work.

Chrome's [non-default profile requirement](https://developer.chrome.com/blog/remote-debugging-port) permits direct debugging of a dedicated profile. It does not force this reader to use an extension bridge.
Neither Playwriter nor a dedicated profile guarantees protection from Slack Enterprise session revocation.

## Usage

```bash
open -a "Google Chrome" --args --profile-directory=Default   # only if Chrome has no window
playwriter browser list                     # must show exactly one browser (Chrome)
playwriter session new --tab-group <word>   # prints a session id
playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
playwriter -s 1 -e 'console.log(await snapshot({ page: state.page }))'   # a11y tree with aria-ref handles
playwriter session delete 1                 # when done
```

- Agent-created tabs (`context.newPage()`) run in the real Chrome profile: cookies and logins apply. No icon click needed.
- Pre-existing tabs need one manual extension-icon click each.
- If `browser list` shows more than one browser, stop. Do not guess a key. Pin with `session new --browser <key>` only after Luis agrees.
- Pipe large snapshots through context-mode (`ctx_execute`/`ctx_search`, source `playwriter-skill` for docs).
- Always close pages you opened and delete your own session. Other sessions belong to other agents.

## Verify and repair

- Health check: `playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); console.log(await state.page.title())'` prints `Example Domain`.
- "Waiting for extension to connect..." or "No browsers detected": Chrome is not running, has no window, or the MV3 worker is asleep. Chrome running with zero windows looks the same as Chrome not running. Open a window with the command above and retry. Do not reinstall first.
- Stale session after a browser restart: `playwriter session reset <id>`, or delete it and create a new one.
- "No current window" from `newPage`: Chrome has no window. Open one.
- Reinstall the extension: open https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe in the `Default` profile, click Add to Chrome, confirm "Add extension". Chrome allows this through normal clicks.
- Browser keys (`install:Chrome:...`) change when the extension is reinstalled. Never hardcode them.

## Not done, deliberately

- No extension in the HelloFresh Chrome profile or in any other browser.
- No Playwright MCP and no second general automation profile. Slack's managed profile is the separate exception above.
- No Chrome DevTools MCP. Revisit if perf debugging becomes a need.
- No token-efficient browser CLIs. context-mode already covers the token problem.
