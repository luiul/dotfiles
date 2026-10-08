# HelloFresh Project Instructions

These instructions apply to every repo under `~/projects/hellofresh` (a flat list of repo checkouts). When a repo has its own context file, the repo-specific guidance wins on conflicts.

## Planning & Tracking

HelloFresh repos do not have GitHub Issues enabled, so the global rule (track plans in GitHub issues) does not apply. Track bigger projects and multi-step plans as Jira tickets in project GLOA, following the Business Impact conventions below. Use in-repo markdown only for working notes that are not ticket-worthy.

## Branch Naming

Enforced org-wide by Mergeable (validated against Jira API).

Use the format: `type/TICKET-description`

- Types (must be one of): `major`, `minor`, `patch`, `issue`, `hotfix`, `feature`, `release`
- Ticket format: `ABC-123` (uppercase letters, dash, numbers), validated against Jira, must be uppercase
- Description: lowercase, words separated by hyphens
- Ask for the Jira ticket. Always include it in the branch name: Mergeable validates the branch against the Jira API and fails ticket-less branches at HEADREF, which blocks merge (seen on global-ops#419; ticket-less #246 never merged).
- Examples: `feature/GLOA-1234-add-login`, `hotfix/GLOA-567-fix-null-pointer` (lowercase words separated by hyphens, no underscores)

## Pull Requests

Follow conventional commit style:

- **Title**: `type: Short Description` in proper case, where type matches the branch type (e.g. `feature: Add Login Page`, `hotfix: Resolve Null Pointer on Checkout`)
- **Body**:

  ```markdown
  ## Summary
  2-4 plain-language sentences: what happened, why, and what the change does

  ## Key Changes
  - List of specific changes made

  ## Test Plan
  - [ ] How the changes were tested
  ```

- **Open as draft**: always create PRs as drafts first (`gh pr create --draft`); leave it to me to mark them ready for review.
- **Assignee**: always assign to me.
- **Labels**: always add the squad and tribe labels `squad: data-engineering` and `tribe: operations-data-and-decisions` (the spaces are an org-wide convention), plus the review-taxonomy labels from **Review taxonomy** below: at minimum the required `impact:<category>` label(s) (one per impact category) and the `scope:<reach>` label; add the recommended `estimate:` and `work_type:` labels where they apply. Create missing labels first (e.g. `gh label create "impact:cost_reduction" --description "Year-end review: cost reduction" --color 0E8A16`). This lets the year-end review filter by label as well as by heading (`gh pr list --label "impact:cost_reduction" --state all`). GitHub PRs only: on Jira the same taxonomy (minus estimate basis, which is harvest-only) lives in the Business Impact body block, since a Jira automation strips custom labels off tickets. The squad/tribe pair above is the post-reorg default for my repos (the pre-reorg pair `squad: scm-analytics-engineers` / `tribe: intl-scm-analytics` is retired). For repos owned by another squad or tribe, match that repo's convention instead: check its recent merged PRs or a repo-level AGENTS.md/CLAUDE.md, which overrides this default (example: ops-intelligence-ae uses `squad: analytics-enablement` / `tribe: ops-tech`). The `Check tribe squad labels` CI check does not reject outdated names, so verify against the repo when unsure.
- No emoji prefixes in title or body.
- No agent attribution, tool footers, or generated-by links (no Claude Code or pi credits).
- Omit empty sections rather than writing "N/A".
- Focus on the "why", not a list of every file changed.
- **Summary first**: the body always starts with a `## Summary` section, written for a reader with no context on the system (what happened, why, what the change does).
- **No `## TLDR` section**: Summary replaces it. Go straight from Summary to Key Changes.
- **Concise, not exhaustive**: plain language plus, when it clarifies the issue, one small concrete example (a few sample rows or a short query result). Do not dump full investigation logs, long JSON payloads, or every query that was run; those belong in the linked Jira ticket. The PR body is the friendly summary, not the full report.

### Org-wide PR rules (enforced by Mergeable)
- PR description cannot be empty
- Title cannot contain "WIP" (use Draft PR instead)
- PR cannot have a "WIP" label
- Requires developer review approval

## Business Impact (required on all Jira tickets)

Every Jira ticket I create or update across all repos under this directory must carry a Business Impact block. This feeds the end-of-year review, so the format is fixed and must stay machine-parseable. The block lives in the ticket description and carries four projected fields: Category, Notes, Scope, Work Type. GitHub PRs do not carry the block; there the taxonomy lives only in labels. Estimated Annual Impact and Estimate Basis are harvest-only: dollar estimates reveal infra spend and efficiency figures, so they never appear on Jira (readable org-wide) and live only in the private harvest store.

### Canonical record: harvest

The six impact fields live as a structured row in harvest, the local DuckDB + Iceberg database at `~/.harvest/` (repo: `~/projects/personal/harvest`, CLI `harvest`). The rule: **harvest is the source of truth for all six impact fields; the Jira ticket and the GitHub PR are projections.** Nothing is written in two places. The canonical sequence (ticket first, always):

1. `harvest create ticket --summary ... -c ... -i ... -n ... -s ... -e ... -w ...` records the full six-field row locally AND creates the Jira ticket with the four-field projection block. Missing fields prompt. (For a ticket that already exists in Jira, `harvest record ticket <KEY> ...` only updates the harvest row.)
2. Branch `type/<KEY>-short-desc`, open the draft PR (body: Summary / Key Changes / Test Plan + Jira link; labels only, NO Business Impact block), then `harvest record pr <repo>#<n> --ticket <KEY>` (impact fields inherit from the ticket row).
3. When an estimate changes: update the harvest row (`harvest record ticket <KEY>` with the new flags), then `harvest project <KEY>` if a projected field (Category, Notes, Scope, Work Type) changed. Dollar/basis changes never touch Jira. PR labels only if category/scope changed.

`harvest project <KEY>` (or `--all`, `--dry-run`) upserts the four-field projection block inside the Jira description: it replaces the block when present, appends it when absent, and never touches other prose. `harvest sync` pulls in the other direction: it ingests lifecycle from Jira (status, resolution, comments) and GitHub (1:n PRs per ticket, state, merged_at, reviews, comments) into the warehouse, and it reports drift (Jira-side manual edits of projected fields; the harvest row always wins). `harvest report --year 2026` gives the review totals, separated into delivered (ticket done, PR merged) and intended (everything recorded). Never put a `## Business Impact` block in a PR body; if one is found on a PR, record it in harvest first, then strip the block (labels stay).

### Canonical block

The harvest row is canonical and holds all six fields. The Jira ticket carries the four-field projection below, in this order, with these field labels (Estimated Annual Impact and Estimate Basis are harvest-only and must never appear on Jira):

```markdown
## Business Impact
- **Category:** `cost_reduction`, `risk_mitigation`
- **Notes:** Removed duplicate DQ coverage, cutting Soda scan compute and on-call triage / false-alert load.
- **Scope:** `tribe`
- **Work Type:** `reliability`
```

### Rules

- **Category** is one or more of: `cost_reduction`, `risk_mitigation`, `increased_revenue`, each wrapped in backticks. Default to a single best-fit category. List multiple (comma-separated, primary driver first) only when the change genuinely delivers on more than one axis (e.g. a migration that both cuts compute cost and removes a data-loss / outage risk); each one listed must be defensible in Notes.
- **Estimated Annual Impact** (harvest-only) is a dollar estimate of annualized business impact, an integer number of USD (e.g. `0`, `12500`, `1200000`). Use `0` only for genuinely zero-dollar work (e.g. pure refactors) and explain why in Notes. Never leave it blank.
- **Notes** is one or two sentences justifying the category (or each, when more than one). Notes are projected to Jira, so they must NOT restate the dollar figure or the estimate basis; the full justification (what drives the number, what assumptions) lives in harvest.
- Never use the tilde `~` for "approximately" in the block (or in PR/ticket Markdown generally): GitHub and Jira parse `~text~` as strikethrough, silently striking everything between two tildes. Write "about", "approx", or "roughly" instead.
- This section is never omitted, even though other sections are omitted when empty.
- **Scope** and **Work Type** are the review-taxonomy fields defined below. Always fill them in (each value in backticks); they are part of the projection on every ticket.
- Always ask me for the category and dollar estimate if you cannot infer them confidently from the change. Do not silently guess a large number.

### Review taxonomy

The review taxonomy (impact category, scope, estimate basis, work type) is recorded as **GitHub PR labels** in `dimension:value` colon-no-space form (`impact:cost_reduction`, `scope:tribe`, `estimate:modeled`, `work_type:reliability`) on PRs, and (except estimate basis, which is harvest-only) as **body fields** in the Jira Business Impact block (`**Category:**`, `**Scope:**`, `**Work Type:**`), each value in backticks. On GitHub PRs only the labels are present (no body block); on Jira only the body fields survive (the label-stripping automation), so do not apply taxonomy labels there. The org-wide `squad: ` / `tribe: ` labels (with their space) are a separate convention, not part of this taxonomy.

- **Category** (`**Category:**` field, required, one or more): `cost_reduction`, `risk_mitigation`, `increased_revenue` (defined above). GitHub label form: `impact:<category>`, one per listed category.
- **Scope** (`**Scope:**` field, required, exactly one): `squad`, `tribe`, `alliance`, `org`, in increasing order of reach. Blast radius of the change; maps to leveling rubrics (scope of influence), so reviewers weigh it alongside dollars. My current org hierarchy: `org` = HelloFresh (Organization), `alliance` = No Alliance Operations Technology (Alliance), `tribe` = Operations Data and Decisions (Tribe), `squad` = Data Engineering (Squad). Pick the widest level the change actually affects. GitHub label form: `scope:<reach>`.
- **Estimate Basis** (harvest-only, recommended, one): `validated` (confirmed against real billing/metrics), `modeled` (computed from a stated model and assumptions), `speculative` (rough judgment, no model). Protects credibility: a validated figure defends itself, a speculative one is flagged as such. Never written on Jira. GitHub label form: `estimate:<basis>` (the label stays; it is non-sensitive).
- **Work Type** (`**Work Type:**` field, recommended, exactly one): `delivery`, `enablement`, `reliability`, `maintenance`. The type of work, orthogonal to dollar impact (which **Category** captures). `delivery` ships a feature, dataset, or pipeline that directly serves a business need; `enablement` is platform/tooling/framework work that unlocks other teams or engineers (the force-multiplier axis leveling rubrics reward, even when its own dollar line is indirect); `reliability` hardens an existing system (DQ, monitoring, incident fixes, resilience); `maintenance` keeps the lights on with no new capability (dependency bumps, refactors, migrations, cleanup). Pick the single best fit. Kept separate from **Category** on purpose: a change can be `cost_reduction` + `enablement` at once. GitHub label form: `work_type:<type>`.

Record one **Category** value per category (usually one, occasionally more), exactly one **Scope**, at most one **Estimate Basis** (harvest row only), and at most one **Work Type**. On GitHub PRs, apply these as labels and create any missing label first (`gh label create "<label>" --description "..." --color <hex>`). When a `speculative` or `modeled` figure is later confirmed, update the harvest row with the actual figure and `validated` basis (`harvest record ticket <KEY> ...`), run `harvest project <KEY>` if Notes changed, and (on GitHub) flip the `estimate:` label.

### Keep it parseable

The year-end review harvests these blocks programmatically (the tooling is harvest, repo `~/projects/personal/harvest`; the store is `~/.harvest/`). All that matters on the authoring side is that the block stays machine-readable:

- Keep the heading text exactly `## Business Impact`.
- Keep the projected field labels exactly `**Category:**`, `**Notes:**`, `**Scope:**`, `**Work Type:**`.
- One field per line, in the fixed order above.
- Wrap every taxonomy value in backticks.
- Never add `**Estimated Annual Impact:**` or `**Estimate Basis:**` lines on Jira; harvest strips them on the next `harvest project` run.

## Verification

- Follow the global Verification rules. The CLIs for checking claims here are in the system table below: `snow`, `databricks`, `aws`, `jira`, `gh`.
- Green PR checks do not prove a deploy. After a merge, check the deploy workflow run before reporting done (PR #378 passed its checks, then the staging deploy failed in the dbt-docs job, 2026-10-01).
- Before blaming your change for a deploy failure, compare prior runs: the same dbt-docs job failed on earlier merges.

## Schemachange (us-ops-analytics-schemachange)

This repo uses the schemachange tool to manage Snowflake objects.

### SQL Script Naming
- Versioned: `VX.X.X__filename.sql` (e.g. `V1.1.1__filename.sql`): runs once, cannot be modified after merge
- Always: `A__filename.sql`: runs every deployment
- Repeatable: `R__filename.sql`: runs when content changes
- Filenames: only numbers, dashes, and dots allowed (no special separators)
- Must have `.sql` extension

### CI/CD Flow
1. PR triggers checks: filename validation, versioned script immutability
2. Clone DB is created from `STAGING_US_OPS_ANALYTICS` for dev/QA
3. Use `US_OPS_ANALYTICS_DEV` role to query clone DB
4. On merge: auto-deploys to staging then live (no manual staging QA step)
5. Clone DB is dropped on merge or PR close

### Snowflake Roles
- `US_OPS_ANALYTICS_SA`: service account role used by schemachange
- `US_OPS_ANALYTICS_DEV`: development role for clone DB access
- `SYSADMIN`: architecture only (managed in snowflake-automation)

### Support
- Slack: `#tribe-us-ops-analytics`
- Docs: https://hellodev.hellofresh.io/docs/default/repository/us-ops-analytics-schemachange/

## Connecting to HelloFresh Systems

CLI-first. Reach every system through its CLI, or a documented `curl` REST recipe where no CLI exists. Exceptions: prefer an approved official Slack MCP for read-only access, as described below. Use the HelloDev knowledge base MCP only when I explicitly ask (see **HelloDev Knowledge Base** below). Never consult the HelloDev KB MCP eagerly or on your own initiative. All tokens live in `~/dotfiles/.env` and are exported into the shell by `.zshrc` (`set -a; source ~/dotfiles/.env`), so any command run here already sees them, including from pi.

| System | Tool | Auth |
| --- | --- | --- |
| GitHub | `gh` CLI | keyring (account `luiul`, intentional) |
| Jira | `jira` CLI | `JIRA_API_TOKEN` (env) |
| Confluence | `curl` REST | same Atlassian token as Jira (`JIRA_API_TOKEN`); Atlassian Cloud tokens are account-wide |
| Snowflake | `snow` CLI | browser SSO |
| Databricks | `databricks` CLI | OAuth |
| AWS (S3, etc.) | `aws` CLI | SSO (`hfsso` session, browser) |
| Google Docs | `md2gdoc` | service account |
| Slack | approved official Slack MCP first; `slack-hf-read` browser fallback | separate OAuth for the current client; no credential capture or replay |
| HelloDev KB | MCP (pi & Claude, via `pi-mcp-adapter`) | none required |

Do not use the Atlassian MCP for Jira or Confluence; the `jira` CLI recipes below and the REST recipes in `docs/confluence-rest.md` replace it.

Detailed recipes live next to this file:

- Snowflake, Databricks, and AWS CLI recipes (connections, SSO login, profiles, S3 access map, query examples): `docs/cli-recipes.md`
- Tardis Airflow task logs straight from S3, no Airflow UI login: `docs/tardis-airflow-logs.md`
- Confluence REST recipes (storage format, mirror repos, page writes): `docs/confluence-rest.md`

## Jira (`jira` CLI)

Use the `jira` CLI (jira-cli, configured for project GLOA at `~/.config/.jira/.config.yml`, token from `JIRA_API_TOKEN`). Do not use the Atlassian MCP.

```bash
jira me                                    # verify auth / show current user
jira issue list -q "project = GLOA AND status = 'In Progress' AND assignee = currentUser()" \
  --order-by created --reverse --plain     # filter via JQL; order via flags, never inline ORDER BY
jira issue list -q "project = GLOA" --raw  # JSON for parsing / summarizing
jira issue view GLOA-123 --comments 5
jira issue create -tTask -s "Summary" -T body.md -a luis.aceituno@hellofresh.com
jira issue comment add GLOA-123 -T comment.md
jira issue move GLOA-123 "In Progress"     # transition
jira issue assign GLOA-123 luis.aceituno@hellofresh.com
jira issue link GLOA-1 GLOA-2 Blocks
```

Conventions:

- Put the description (and long comments) in a markdown file and pass it with `-T file.md`. jira-cli converts Markdown to Jira markup, so the old MCP `\n`-escaping quirk no longer applies.
- Every ticket description must end with the **Business Impact** block defined in the canonical spec above (same heading, same fields, same allowed values), carrying the four projected fields `**Category:**`, `**Notes:**`, `**Scope:**`, and `**Work Type:**`. Never the dollar figure or the estimate basis on Jira. On Jira the body is the only durable record (the automation strips custom labels), so the block must be complete. Add it on updates if missing.
- Do **not** add review-taxonomy labels (`impact:`, `scope:`, `estimate:`, `work_type:`) on Jira tickets; the automation removes them. Those labels stay on GitHub PRs only.
- Wrap every file path, SQL identifier, column name, and code token in backticks (bare underscores render as emphasis otherwise). Do not use Markdown link syntax `[text](path)` for local file references; list the path in a code span.
- JQL ordering: jira-cli rejects inline `ORDER BY`; use `--order-by <field> [--reverse]`.
- After create/update, fetch back with `jira issue view <KEY>` and confirm the body and Business Impact block render as intended.
- **Board 15367 (GLOA Scrum Board) has no visibility gate**: its saved filter (id 59649) is `project = GLOA`, so every GLOA ticket lands on the board and backlog with no extra fields. `fixVersions` is optional: the project's only version is `Central Ops Data Assets` (id `59925`); set it only for tickets in that asset stream, with the REST call below (`jira issue create` does not expose `--fix-version`):
  ```bash
  curl -s -u "luis.aceituno@hellofresh.com:$JIRA_API_TOKEN" -X PUT \
    "https://hellofresh.atlassian.net/rest/api/3/issue/GLOA-XXXXX" \
    -H 'Content-Type: application/json' \
    --data '{"fields":{"fixVersions":[{"id":"59925"}]}}'
  ```

## Slack: READ ONLY, official MCP first, browser fallback

**Pi reads only.** Never post, react, upload, change membership, or enter message drafts. Prefer an approved, authenticated [official Slack MCP](https://docs.slack.dev/ai/slack-mcp-server) at `https://mcp.slack.com/mcp`, available to the current Pi session. Use only verified read tools. Do not assume Claude's Slack plugin is accessible or authenticated in Pi. Each client needs its own authorized OAuth connection. Do not copy credentials or borrow another client's identity.

No Slack MCP is configured in Pi. The official endpoint was removed because it requires an approved OAuth client and rejects dynamic registration. Do not add it again without explicit user approval and a supported auth setup.

If no authorized MCP read path is available, use `slack-hf-read`, under `~/dotfiles/hellofresh/slack-hf-read/`, as the browser fallback. It reads rendered UI through the dedicated Brave Beta profile without token capture, cookie extraction, or hand-built APIs. Normal navigation may change read state. Do not restore the retired credential-replay `slack-mcp-server`, or use `slackcli`, `slack-relogin`, `slack-hf-session`, or `slackdump`. Shared manual tools and Claude's configuration remain unchanged.

Fallback is for an unavailable integration or unsupported read operation, not a way around access controls. On MCP auth loss, access denial, rate limiting, or suspected account-wide revocation, stop and report the error. Do not switch clients or retry credentials to work around it. Keep the browser's persistent auth pause and explicit recovery rules.

**Normal workflow is link-only.** The user supplies a Slack permalink. Use it with the MCP's exact-message or thread read tool, checking the linked timestamp. If the authorized MCP is unavailable, use `slack-hf-read read '<url>' --limit 1`. Do not browse the sidebar or search when a link is supplied. The CLI's automatic permalink opening has not passed live verification. Extraction of the exact already-rendered message has passed. A `ui_changed` result means no message was read, not permission to use credential replay.

| Command | Purpose |
|---|---|
| `slack-hf-read read '<url>' --limit 1` | Exact linked message only, fails closed if not rendered |
| `slack-hf-read status` | Local diagnostics only, no Slack traffic |
| `slack-hf-read pause` | Stop reads across Pi runs |
| `slack-hf-read channels --limit N` | Rendered joined channels only |
| `slack-hf-read history <channel_id> --limit N [--after YYYY-MM-DD] [--before YYYY-MM-DD]` | Rendered history only |
| `slack-hf-read replies <channel_id> <thread_ts> --limit N` | Rendered thread messages only |
| `slack-hf-read search '<query>' --limit N` | Rendered search results only |
| `slack-hf-read doctor` | Point-in-time UI verification, not recovery |
| `slack-hf-read await-login` | Passive explicit login verification, clears pause on success |

Limits range from 1 through 100. Use channel IDs from Slack URLs. Convert a permalink's `p<digits>` timestamp by inserting a decimal before its last six digits. Results use `schema_version:1`, `source:"headed_ui"`, `data`, and `coverage`. Treat `coverage.complete:false` as partial. There are no cursor guarantees or automatic retries. Dates filter rendered history only, and `--before` is exclusive.

**Recovery:** Confirm desktop Slack is signed in first. Run `slack-hf-session-login` to start the managed headed profile. The user completes SSO manually. Run `slack-hf-read await-login` to observe the workspace without repeated auth tests. Leave the window open for reads, minimized if desired. Closing it stops reads until it is reopened. The helper never launches a hidden headless browser. An old unmanaged holder must be closed by the user before the updated helper starts it. Do not close daily Brave or unrelated tabs.

Auth loss or sign-in redirection persists a shared pause. Do not retry reads or loop login attempts. Only explicit successful login verification clears the pause. The shared owned lock covers both reads and recovery. Do not remove a lock manually while its owner may be alive. `status` reports local lock and pause information without testing Slack credentials.

A dedicated profile does not protect desktop sessions from [Slack Anomaly Event Response](https://slack.engineering/building-slacks-anomaly-event-response/). [Enterprise session policy](https://slack.com/help/articles/115005223763-Manage-session-duration) can also force sign-in. Keeping a window open cannot override policy. Do not claim a fixed cooldown cures revocation. Report the cause as unknown without stronger evidence. If reads still correlate with desktop sign-outs, pause automation rather than adding evasion or credential replay. Do not add background keepalives or synthetic health polling.

**Separate manual directory tooling, not a Pi fallback:** The existing `curl` recipes use `SLACK_TOKEN` from `.env` with directory-read scopes. Leave these tools and Claude's integration unchanged. Manual examples:

```bash
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'types=public_channel' --data-urlencode 'limit=20' \
  https://slack.com/api/conversations.list | jq '.channels[] | {id, name}'   # list channels
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'limit=20' \
  https://slack.com/api/users.list | jq '.members[] | {id, name}'             # list users
curl -s -H "Authorization: Bearer $SLACK_TOKEN" https://slack.com/api/auth.test | jq .  # identity
```

That token cannot read message history or search. Pi uses the approved official MCP first, with the managed browser fallback described above.

## HelloDev Knowledge Base

The internal KB is exposed only as an HTTP MCP endpoint (`hellofresh-kb`, `.../mcp/v2`) with no REST or CLI equivalent. Unlike the approved Slack MCP read path, KB use always needs an explicit request.

**Do not consult the HelloDev KB / `kb_*` MCP tools eagerly.** Only query it when I explicitly ask (e.g. "check HelloDev", "ask the KB", "search the knowledge base"). For everything else, prefer the repo checkout, the CLIs/REST recipes above, and what is already in context. Do not reach for these tools on your own initiative just because a question is HelloFresh-related.

- Claude reaches it via the `hellofresh-kb` server in `~/.claude.json`.
- pi reaches it via [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) (the `kb` server in `~/dotfiles/pi/.pi/agent/mcp-adapter.json`), which registers each MCP tool directly, prefixed `kb_` (e.g. `kb_search_internal_knowledge_base`). Run `/mcp` in pi to list bridged servers/tools. The endpoint is reachable on the corporate network without a token.

Note: this MCP serves the KB content, not the Backstage docs portal at `hellodev.hellofresh.io`. That portal is a JS SPA behind OAuth; `curl` only returns the app shell, and `/api/techdocs/*` is auth-gated. For docs that exist in a local repo checkout, read the repo copy instead.
