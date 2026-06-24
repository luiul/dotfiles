# Work Systems Integration

How the agents (pi and Claude Code) talk to HelloFresh systems, the rationale, and the rollout plan. Tracked in this repo. The operational playbooks (exact commands) live in the canonical context files (see Part 2); this file is the design + tracker.

## Locked decisions

- **CLI-first.** Keep MCP only for MCP-native capabilities that have no CLI or REST path.
- **One canonical document** per concern, shared by all agents via symlink, managed in this repo and stowed.
- **pi gets the HelloFresh context** (was Claude-only).
- **Tokens live in the `.env` / gitleaks flow**, not plaintext `~/.claude.json`.
- **`gh` stays on personal account `luiul`** (intentional: one account for work and personal).
- **HelloDev KB stays on MCP** (Claude-only) until a REST API appears.
- **Confluence and Slack**: documented `curl` recipes first; build a shared CLI only if usage justifies it.

---

## Part 0: Why CLI-first (and where it does not apply)

**pi ships with no MCP.** Its docs are explicit: "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support." So for pi this is not "CLI vs MCP", it is "CLI vs build-your-own-MCP-bridge". CLI is the lower-effort, agent-agnostic path.

**Where CLI clearly wins (mature CLI already installed and authed):** Jira (`jira`), GitHub (`gh`), Snowflake (`snow`), Databricks, gcloud, Google Docs (`md2gdoc`).
- Agent-agnostic: one playbook works for pi and Claude. MCP is per-agent and pi cannot consume it.
- No upfront context tax: the Atlassian MCP loads ~40 tool schemas into every Claude session; a scoped CLI playbook is lighter and only loads in the relevant context.
- Secrets stay in `.env`, not plaintext MCP config.
- Composable (pipe to `jq`, write to files) and auditable.

**Where it is a real tradeoff (no CLI exists, so "CLI" means build + maintain a tool):** Confluence, Slack. For Claude alone an off-the-shelf MCP is less work; the unification goal (pi cannot use MCP) tips it back to "one CLI both agents share". Hedge: `curl` recipes first, build a tool only if usage justifies it.

**Where CLI does not make sense:** HelloDev KB. Its endpoint is `.../mcp/v2`, i.e. MCP-native, and likely has no REST equivalent. Keep it as MCP (Claude-only) until a REST API turns up, or reach it later via a pi MCP-bridge extension.

**Honest downsides of CLI:** the agent can guess wrong flags (mitigated by tight, example-driven playbooks) and CLI output needs parsing (use `--raw` / `--json`, not pretty tables).

---

## Part 1: Current state (condensed)

| System | Claude | pi | CLI available | New default |
| --- | --- | --- | --- | --- |
| GitHub | `gh` CLI | `gh` CLI | yes (`gh`, account `luiul`) | `gh` (no change) |
| Jira | `mcp-atlassian` MCP | nothing | **yes, `jira` CLI (ISA), unused** | `jira` CLI |
| Confluence | `mcp-atlassian` MCP | nothing | no native CLI (REST) | `curl` REST (token = `JIRA_API_TOKEN`, cross-product), maybe `confl` later |
| Slack | `slack` MCP plugin | nothing | not installed (Web API) | `curl` Web API, maybe `slackcli` later |
| HelloDev KB | `hellofresh-kb` HTTP MCP | nothing | no (MCP-native) | keep MCP (Claude-only) |
| Google Workspace | `md2gdoc` + `gcloud` | same | yes | unchanged |
| Snowflake | `snow` CLI | undocumented for pi | yes | `snow` (document for pi) |
| Databricks | `databricks` CLI | undocumented for pi | yes | `databricks` (document for pi) |
| AWS | SSO/Bedrock | `aws-sso-refresh` ext | yes | unchanged |
| Diagrams | excalidraw + drawio MCP | nothing | no | keep MCP or drop (low priority) |

Facts the plan relies on:
- pi loads `AGENTS.md` **or** `CLAUDE.md` per directory: global `~/.pi/agent/`, parents walking up from cwd, then cwd. No `@import` syntax.
- Claude loads `~/.claude/CLAUDE.md` (global) and `CLAUDE.md` walking up from cwd.
- `.zshrc` runs `set -a; source ~/dotfiles/.env`, so every `.env` key is exported and inherited by pi, Claude, and spawned CLIs.
- `.env` is gitignored, keys mirrored to `example.env` by the pre-commit hook, and `gitleaks protect --staged` guards commits.
- `jira` CLI (jira-cli 1.7.0) configured at `~/.config/.jira/.config.yml` for project ISA, reads `JIRA_API_TOKEN` from env.

---

## Part 2: Canonical-document architecture

### Mechanism (one document, both agents)

pi and Claude look for different filenames, so each context dir keeps **one real file** plus a **symlink** for the other name. Each agent reads exactly one name, identical bytes, no double-loading.

- `AGENTS.md` = real canonical file.
- `CLAUDE.md` = symlink to it.

Global prefs live in two different home dirs, so the canonical file is in the pi package and the Claude entrypoint is a cross-package relative symlink to it.

### Layout (implemented in Phase 1)

```
pi/.pi/agent/AGENTS.md                         # canonical global prefs (real)
claude/.claude/CLAUDE.md         -> ../../pi/.pi/agent/AGENTS.md
hellofresh/projects/hellofresh/AGENTS.md       # canonical HelloFresh context (real)
hellofresh/projects/hellofresh/CLAUDE.md -> AGENTS.md
AGENTS.md                                      # canonical dotfiles-repo context (real)
CLAUDE.md                        -> AGENTS.md
```

Verified resolution after stow:

```
~/.pi/agent/AGENTS.md              -> dotfiles/pi/.pi/agent/AGENTS.md
~/.claude/CLAUDE.md                -> dotfiles/pi/.pi/agent/AGENTS.md   (same source)
~/projects/hellofresh/AGENTS.md    -> dotfiles/hellofresh/projects/hellofresh/AGENTS.md
~/projects/hellofresh/CLAUDE.md    -> dotfiles/hellofresh/projects/hellofresh/AGENTS.md
```

### Scratch dir

Standardized on a single shared path `~/scratch` (was `~/.claude/scratch` for Claude and `~/.pi/scratch` for pi). The canonical global prefs reference it; `~/scratch` is created on setup.

---

## Part 3: CLI playbooks (to add to the canonical context in later phases)

### Jira (`jira` CLI) — replaces ~40 MCP tools

```bash
jira issue list -q "project = ISA AND status = 'In Progress' AND assignee = currentUser()"
jira issue list --raw                 # JSON for parsing
jira issue view ISA-123 --comments 5
jira issue create -tTask -s "Summary" -T body.md \
  -a luis.aceituno@hellofresh.com \
  -l "squad: scm-analytics-engineers" -l "tribe: intl-scm-analytics"
jira issue comment add ISA-123 -T comment.md
jira issue move ISA-123 "In Progress"
jira issue assign ISA-123 luis.aceituno@hellofresh.com
jira issue link ISA-1 ISA-2 Blocks
```

- `-T file.md` reads the description/comment from a markdown file: the home for the mandatory Contribution & Business Impact block.
- jira-cli converts markdown to Jira markup, so the MCP `\n` double-escaping quirk goes away. Still wrap identifiers in backticks; verify with `jira issue view`.

### Confluence — `curl` REST first

`CONFLUENCE_URL` + `CONFLUENCE_USERNAME` + `CONFLUENCE_API_TOKEN` from `.env`. Document get / search (CQL) / children / update recipes, preserving the frontmatter-mirror workflow (`confluence_page_id`, `confluence_space`, strip frontmatter + first H1, push, verify). Build a thin `confl` uv tool (md2gdoc-style) only if usage justifies it.

### Slack — `curl` Web API first

`SLACK_TOKEN` from `.env` (scopes `chat:write`, `channels:history`, `groups:history`, `search:read`). Document post / read / search / reply recipes against `https://slack.com/api/*`. Build a thin `slackcli` uv tool only if usage justifies it.

---

## Part 4: Secrets migration

1. Remove the `mcp-atlassian` server from `~/.claude.json` (deletes the two plaintext Atlassian tokens) once Jira and Confluence are on CLI/REST.
2. Ensure `.env` holds: `JIRA_API_TOKEN` (present), add `CONFLUENCE_URL`, `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN`, `SLACK_TOKEN`, and (if used) `MD2GDOC_SA_KEY`.
3. `.zshrc` already exports them; the pre-commit hook mirrors keys to `example.env`; gitleaks guards commits. No new plumbing.
4. Drop the `slack` MCP plugin from Claude once the Slack recipes/tool work. Keep `hellofresh-kb` (and optionally the diagram MCPs).

---

## Part 5: Rollout

**Phase 1: Consolidate context (no new tools). DONE.**
- HelloFresh context: `CLAUDE.md` -> `AGENTS.md` + `CLAUDE.md` symlink; re-stowed so pi loads `~/projects/hellofresh/AGENTS.md`.
- Global prefs: canonical in `pi/.pi/agent/AGENTS.md` (merged the "Large Files" guidance, noted the intentional `luiul` account); `claude/.claude/CLAUDE.md` is now a symlink to it.
- Dotfiles-repo context: `CLAUDE.md` -> `AGENTS.md` + `CLAUDE.md` symlink.
- Scratch standardized on `~/scratch` (dir created).
- Verified all entrypoints resolve to the two canonical files.

**Phase 2: Jira to CLI. DONE (docs).**
- Jira CLI playbook added to the canonical HelloFresh context; validated from pi (`jira me`, `jira issue list -q "project = ISA"`).
- Captured the jira-cli JQL quirk: no inline `ORDER BY`, use `--order-by <field> [--reverse]`.
- Still to do: remove `mcp-atlassian` from `~/.claude.json` (sequence with Phase 3 so Confluence is not orphaned); validate create/comment/transition on a scratch ISA ticket.

**Phase 3: Confluence + Slack (curl first). PARTIAL.**
- Confluence: `curl` REST recipes added to the canonical context; reads (page, CQL search, children) validated from pi. Key finding: the existing `JIRA_API_TOKEN` authenticates Confluence too (Atlassian Cloud tokens are account-wide), so no new secret is needed for reads. Writes need storage-format XHTML, so Markdown push waits for the `confl` tool.
- Slack: `curl` Web API recipes added to the canonical context, gated on adding `SLACK_TOKEN` to `.env` (bot/user token, scopes `chat:write`, `channels:history`, `groups:history`, `search:read`).
- Still to do: add `SLACK_TOKEN` to `.env`; retire the Atlassian Confluence MCP and the Slack MCP plugin; build `confl` / `slackcli` only if usage justifies it.

**Phase 4: Cleanup.**
- Document Snowflake/Databricks for pi (port from the HelloFresh context, already CLI-based).
- Confirm `~/.claude.json` has no plaintext tokens left.
- Decide the fate of the diagram MCPs.

---

## Remaining open items

- [ ] Confirm `~/scratch` is the preferred shared scratch path (vs `~/.scratch` or keeping under one agent).
- [ ] Add `mkdir -p ~/scratch` to `setup.sh` for fresh-machine bootstrap.
- [ ] Add `SLACK_TOKEN` to `.env` (and decide bot vs user token) to activate the Slack recipes.
- [ ] Remove the `mcp-atlassian` server (and Slack MCP plugin) from `~/.claude.json` once both agents rely on CLI/REST.
- [ ] Build `confl` / `slackcli` uv tools if curl usage proves frequent.
