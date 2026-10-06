# slack-hf-read

Read-only Slack access for pi in the HelloFresh workspace, through Slack's own web client running in a dedicated Brave Beta profile (`~/.pi/agent/data/slack-session`).

No credential replay of any kind: the browser is the client. Slack Web API calls are made by in-page `fetch()` with the page's own token (captured from the app's live traffic) and cookies, so to Slack they are indistinguishable from the web app itself. This replaced the korotovsky/slack-mcp-server MCP path on 2026-11-05; see the Slack section of `~/projects/hellofresh/AGENTS.md` for the full history.

## Usage

```
slack-hf-read doctor                                  # in-page auth.test (session health)
slack-hf-read channels [--limit N] [--cursor C]       # conversations.list
slack-hf-read history <channel_id> [--limit N] [--cursor C] [--after YYYY-MM-DD] [--before YYYY-MM-DD]
slack-hf-read replies <channel_id> <thread_ts> [--limit N] [--cursor C]
slack-hf-read search <query> [--limit N]              # search.messages
slack-hf-read await-login                             # verify a fresh sign-in from inside the login window
```

Every command prints the raw Slack API JSON to stdout. The `slack-hf-read` bin (stowed to `~/.local/bin/`) serializes concurrent runs with a lock.

## Session holder window

`slack-hf-session-login` (in `../.local/bin/`) opens a separate Brave Beta window with the dedicated profile and a localhost debug port (9223). Sign in via SSO once, verify with `slack-hf-read await-login`, then LEAVE THE WINDOW OPEN (minimized): the app keeps the session fresh and reads attach to it over CDP (fresh tab per read, closed afterwards). If the window is not open, reads fall back to a headless launch of the profile.

## Development

Runtimes: node >= 24 (strips the TypeScript types natively). Do NOT run under bun: playwright-core's CDP websocket handshake to Brave hangs there.

Install deps after a fresh checkout (node_modules is gitignored):

```
bun install   # or npm install
```

Run directly: `node src/main.ts doctor`

Env overrides: `SLACK_HF_PROFILE_DIR` (profile location), `SLACK_HF_READ_DIR` (project dir for the bin wrapper).
