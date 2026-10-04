# Browser Automation

Setup for letting agents (pi, Claude Code) drive a real browser with logged-in sessions. Default tool is playwriter against the Brave Beta automation profile. Playwright MCP stays for clean-room work. Documented 2026-10-04 so we can iterate on it.

## Components

| Component | What | Where |
|---|---|---|
| playwriter CLI | npm global package, currently 0.7.0. Sessions, relay control, MCP mode | `/opt/homebrew/bin/playwriter` (`npm i -g playwriter`) |
| playwriter extension | Chrome Web Store extension, id `jfeammnjpkecdekppnclgkkffahnhfhe` | Installed ONLY in the Brave Beta automation profile: `~/.pi/agent/data/playwright-brave-beta/Default/Extensions/` |
| Relay daemon | WebSocket bridge between CLI and extension | `localhost:19988`, auto-starts on first CLI command, no manual service |
| pi MCP entry | `playwriter` server in `~/.pi/agent/mcp-adapter.json`, proxy mode (`directTools: false`), lazy | Live file + snapshot at `pi/.pi/agent/mcp-adapter.json` |
| Skill | Full playwriter CLI reference, loaded on demand | `~/pi-skills/pi-native/playwriter/SKILL.md`, also indexed in context-mode as source `playwriter-skill` |
| Playwright MCP | `@playwright/mcp@0.0.83` driving Brave Beta with the same profile | Unchanged, entry in `mcp-adapter.json` |
| Stable Brave | The daily browser. Deliberately has NO playwriter extension | Off limits for agents (user decision 2026-10-04) |

## Decisions and why

- Real browser over fresh instance: a fresh Playwright browser has no logins and gets flagged by bot detection (Reddit blocks CDP-driven browsers). Since Chrome 136, `--remote-debugging-port` is refused on the default profile, so an extension bridge is the only practical way to drive a real, logged-in browser.
- playwriter over alternatives: Browser MCP (7k stars) is unmaintained since 2025-04, real-browser-mcp (52 stars) and browser-controller (4 stars) are too immature, browser-use/Stagehand/Skyvern bundle their own agent loop which pi already provides. playwriter: full Playwright API, active maintenance, MCP + CLI, works on Brave via MV3.
- CLI + skill over MCP direct tool: playwriter's MCP `execute` tool embeds 53.6KB of docs in its description (~13k tokens). Registered as a direct tool it would sit in the standing prompt of every request. Proxy mode keeps it out of context; the CLI with the on-demand skill costs ~30 standing tokens. Measured 2026-10-04 via a stdio initialize/tools/list handshake.
- Beta-only: the stable Brave extension was installed, verified working (HelloFresh Gmail from an agent-created tab), then removed on user request. Do not reinstall or route agents to stable Brave unless Luis explicitly asks. Work sessions (HelloFresh Google account) are NOT reachable; personal Gmail (aceitunosoriano@gmail.com) is logged in inside the Beta profile.

## Usage

```bash
playwriter session new                      # once, prints a session id
playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com")'
playwriter -s 1 -e 'console.log(await snapshot({ page: state.page }))'   # a11y tree with aria-ref handles
playwriter -s 1 -e 'await state.page.locator("aria-ref=e5").click()'
```

- Agent-created tabs (`context.newPage()`) run in the real Beta profile: cookies and logins apply. No icon click needed.
- Pre-existing tabs need one manual extension-icon click each (native UI, cannot be automated).
- `playwriter browser list` shows connected browsers; pin with `playwriter session new --browser <key>`.
- Pipe large snapshots through context-mode (`ctx_execute`/`ctx_search`, source `playwriter-skill` for docs) to keep bytes out of context.

## Verify and repair

- Health check: `playwriter -s 1 -e 'state.page = await context.newPage(); await state.page.goto("https://example.com"); console.log(await state.page.title())'` should print `Example Domain`.
- Stale session after browser restart or idle: `playwriter session reset <id>`. The extension auto-reconnects to the relay after a browser restart (verified), but MV3 service workers suspend when idle, so `browser list` can temporarily show one entry until that browser gets tab activity.
- Reinstall the extension in Beta: open the Web Store page in the Beta profile, click "Add to Brave", then send Enter to confirm the native dialog (worked via Playwright MCP `browser_press_key`).
- Removing the extension is harder: the Chrome Web Store blocks CDP navigation (`Page.navigate: Not allowed`) and chrome:// WebUI ignores synthetic CGEvent clicks. What works: pyobjc `AXUIElement` tree walk + `AXPress` on the "Remove extension" link, then `AXPress` on the confirm dialog's "Remove" button. Note the daily Brave windows live in a separate macOS Space (portrait display); `tell application "Brave Browser" to make new window` lands in the active Space and is the reliable way to get a capturable, clickable window.

## Not done, deliberately

- No extension in stable Brave (see Beta-only decision).
- No Chrome DevTools MCP: official and mature, but its extra value is perf traces and Lighthouse audits, not driving. Revisit if perf debugging becomes a need.
- No token-efficient browser CLIs (browse, agent-browser, caveman-browse): context-mode already covers the token problem.
