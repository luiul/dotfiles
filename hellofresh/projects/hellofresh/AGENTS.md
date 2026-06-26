# HelloFresh Project Instructions

These instructions apply to every repo under the subfolders of `~/projects/hellofresh` (`01-generation/`, `02-ingestion/`, `03-transformation/`, `04-serving/`, `05-orchestration/`, `06-governance-infra/`, `misc/`). When a repo has its own context file, the repo-specific guidance wins on conflicts.

## Planning & Tracking

HelloFresh repos do not have GitHub Issues enabled, so the global rule (track plans in GitHub issues) does not apply here. Track bigger projects and multi-step plans as Jira tickets in project ISA, following the Business Impact conventions below. Use an in-repo markdown doc only for working notes that are not ticket-worthy.

## Branch Naming

Enforced org-wide by Mergeable (validated against Jira API).

Use the format: `type/TICKET-description`

- Types (must be one of): `major`, `minor`, `patch`, `issue`, `hotfix`, `feature`, `release`
- Ticket format: `ABC-123` (uppercase letters, dash, numbers), validated against Jira, must be uppercase
- Description: lowercase, words separated by hyphens
- Ask for the Jira ticket. Only include the ticket in the branch name if one is provided.
- Examples: `feature/ISA-1234_add-login`, `hotfix/ISA-567_fix-null-pointer`

## Pull Requests

Follow conventional commit style:

- **Title**: `type: Short Description` in proper case, where type matches the branch type (e.g. `feature: Add Login Page`, `hotfix: Resolve Null Pointer on Checkout`)
- **Body**:

  ```markdown
  ## Summary
  - Brief bullet points explaining the changes

  ## Key Changes
  - List of specific changes made

  ## Test Plan
  - [ ] How the changes were tested

  ## Business Impact
  - **Category:** one or more of `cost_reduction` | `risk_mitigation` | `increased_revenue` (comma-separated, primary driver first)
  - **Estimated Annual Impact:** $X,XXX
  - **Notes:** Short justification for the category and the dollar estimate
  ```

- The **Business Impact** section is required on every PR (see the canonical spec below). It is the one section that is never omitted, even when impact is small or indirect.
- **Open as draft**: always create PRs as drafts first (`gh pr create --draft`); leave it to me to mark them ready for review.
- **Assignee**: always assign to me
- **Labels**: always add the squad and tribe labels `squad: scm-analytics-engineers` and `tribe: intl-scm-analytics` (these keep their spaces, they are an org-wide convention), plus the review-taxonomy labels defined in **Review labels (taxonomy)** below. At minimum apply the required `impact:<category>` label(s) (one per category in the Business Impact block) and the `scope:<reach>` label; add the recommended `estimate:` and `kind:` labels where they apply. Create any missing label in the repo first (e.g. `gh label create "impact:cost_reduction" --description "Year-end review: cost reduction" --color 0E8A16`). This lets the year-end review filter by label as well as by heading (`gh pr list --label "impact:cost_reduction" --state all`).
- No emoji prefixes in title or body
- No agent attribution, tool footers, or generated-by links (no Claude Code or pi credits)
- Omit empty sections rather than writing "N/A"
- Focus on the "why", not a list of every file changed

### Org-wide PR rules (enforced by Mergeable)
- PR description cannot be empty
- Title cannot contain "WIP" (use Draft PR instead)
- PR cannot have a "WIP" label
- Requires developer review approval

## Business Impact (required on all PRs and Jira tickets)

Every PR I open and every Jira ticket I create or update across all repos in the subfolders of this directory must carry a Business Impact block. This feeds the end-of-year review, so the format is fixed and must stay machine-parseable.

### Canonical block

Use exactly these three fields, in this order, with these labels:

```markdown
## Business Impact
- **Category:** `cost_reduction`, `risk_mitigation`
- **Estimated Annual Impact:** $120,000
- **Notes:** Removed duplicate DQ coverage, cutting Soda scan compute (cost) and reducing on-call triage / false-alert risk (risk).
```

### Rules

- **Category** is one or more of: `cost_reduction`, `risk_mitigation`, `increased_revenue`. Always wrap each in backticks. Most changes have a single best-fit category, so default to one. List multiple (comma-separated, primary driver first) only when the change genuinely delivers on more than one axis (e.g. a migration that both cuts compute cost and removes a data-loss / outage risk). Do not pad the list with weakly-related categories; each one listed must be defensible in Notes.
- **Estimated Annual Impact** is a dollar estimate of annualized business impact, formatted `$` + number with thousands separators (e.g. `$0`, `$12,500`, `$1,200,000`). Use `$0` only for genuinely zero-dollar work (e.g. pure refactors) and explain why in Notes. Never leave it blank or write "N/A" / "TBD".
- **Notes** is one or two sentences justifying the category (or each category, when more than one) and the dollar figure (what drives the number, what assumptions).
- Do not use the tilde `~` for "approximately" anywhere in the block (or in PR/ticket Markdown generally). GitHub and Jira parse `~text~` as strikethrough, which silently strikes through everything between two tildes. Write "about", "approx", or "roughly" instead.
- This section is never omitted, even though other sections are omitted when empty.
- **Apply the matching label(s)** on the PR and the Jira ticket using the colon, no-space form: `impact:cost_reduction`, `impact:risk_mitigation`, and/or `impact:increased_revenue` (no backticks). Apply one `impact:` label per category listed in the **Category** field, and the set of labels must agree with that field exactly (no extra, no missing). Create any label first if it is missing. This gives the year-end review a second, label-based way to filter (independent of parsing the body). See **Review labels (taxonomy)** below for the required `scope:` and the optional `estimate:` dimension.
- Always ask me for the category and dollar estimate if you cannot infer them confidently from the change. Do not silently guess a large number.

### Review labels (taxonomy)

All review-taxonomy labels use the `dimension:value` form with a colon and **no space**, identical on GitHub and Jira (Jira labels cannot contain spaces, so one label string serves both platforms and keeps the harvest trivial). This is distinct from the org-wide `squad: ` / `tribe: ` labels, which keep their space and are not part of this taxonomy.

- `impact:` (required, one or more): `impact:cost_reduction`, `impact:risk_mitigation`, `impact:increased_revenue`. The set of `impact:` labels must match the **Category** field exactly: one label per listed category. Most changes carry a single `impact:` label; apply multiple only when the change genuinely delivers on more than one axis.
- `scope:` (required, exactly one): `scope:squad`, `scope:tribe`, `scope:alliance`, `scope:org`, in increasing order of reach (`squad` < `tribe` < `alliance` < `org`). Blast radius / reach of the change. Maps to leveling rubrics (scope of influence), so reviewers weigh it alongside dollars. My current org hierarchy maps these levels as: `scope:org` = HelloFresh (Organization), `scope:alliance` = No Alliance Operations Technology (Alliance), `scope:tribe` = Operations Data and Decisions (Tribe), `scope:squad` = Data Engineering (Squad). Pick the widest level the change actually affects.
- `estimate:` (recommended, one): `estimate:validated` (confirmed against real billing/metrics), `estimate:modeled` (computed from a stated model and assumptions), `estimate:speculative` (rough judgment, no model). Protects credibility: a validated figure defends itself, a speculative one is flagged as such.
- `kind:` (recommended, exactly one): `kind:delivery`, `kind:enablement`, `kind:reliability`, `kind:maintenance`. The *type* of work, orthogonal to its dollar impact (which is what `impact:` captures). `kind:delivery` ships a feature, dataset, or pipeline that directly serves a business need; `kind:enablement` is platform/tooling/framework work that unlocks other teams or engineers (the force-multiplier axis leveling rubrics reward, even when its own dollar line is indirect); `kind:reliability` hardens an existing system (DQ, monitoring, incident fixes, resilience); `kind:maintenance` keeps the lights on with no new capability (dependency bumps, refactors, migrations, cleanup). Pick the single best-fit kind. This dimension stays separate from `impact:` on purpose: a change can be `impact:cost_reduction` + `kind:enablement` at the same time.

Apply one `impact:` label per category in the **Category** field (usually one, occasionally more), exactly one `scope:` label, at most one `estimate:` label, and at most one `kind:` label. Create any missing label in the repo first (`gh label create "<label>" --description "..." --color <hex>`). When an `estimate:speculative` or `estimate:modeled` figure is later confirmed, update the Notes with the actual and flip the label to `estimate:validated`.

### Parseability (for year-end review)

- Keep the heading text exactly `## Business Impact` so it can be grepped across PRs and tickets.
- Keep the field labels exactly `**Category:**`, `**Estimated Annual Impact:**`, `**Notes:**`.
- One field per line, in the fixed order above.
- Example harvest by body: `gh pr list --author @me --state all --json title,body,url` then extract the block by the heading and field labels.
- Example harvest by label: `gh pr list --author @me --state all --label "impact:cost_reduction" --json title,url` (repeat per category, and per `scope:` / `estimate:` / `kind:` dimension).

## Commits

- Complete all file changes before staging or committing, let the user review first
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines

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

## Python

- Always use `uv` for Python operations (`uv run` instead of `python`, `uv pip` instead of `pip`, `uv venv` instead of `python -m venv`, etc.)

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)

## Connecting to HelloFresh Systems

CLI-first. Reach every system through its CLI, or a documented `curl` REST recipe where no CLI exists. Use MCP only for capabilities that are MCP-native with no CLI/REST path (the HelloDev knowledge base). All tokens live in `~/dotfiles/.env` and are exported into the shell by `.zshrc` (`set -a; source ~/dotfiles/.env`), so any command run here already sees them, including from pi.

| System | Tool | Auth |
| --- | --- | --- |
| GitHub | `gh` CLI | keyring (account `luiul`, intentional) |
| Jira | `jira` CLI | `JIRA_API_TOKEN` (env) |
| Confluence | `curl` REST | same Atlassian token as Jira (`JIRA_API_TOKEN`); Atlassian Cloud tokens are account-wide |
| Snowflake | `snow` CLI | browser SSO |
| Databricks | `databricks` CLI | OAuth |
| AWS (S3, etc.) | `aws` CLI | SSO (`hfsso` session, browser) |
| Google Docs | `md2gdoc` | service account |
| Slack | `curl` Web API (directory reads) + MCP plugin (messaging) | `SLACK_TOKEN` (env, directory scopes only) |
| HelloDev KB | MCP (Claude only) | no pi path yet |

Do not use the Atlassian MCP for Jira or Confluence; the CLI and REST recipes below replace it.

## Snowflake CLI (`snow`)

Installed via Homebrew (`snow --version` → Snowflake CLI v3.16.0). Config at `~/.snowflake/config.toml`.

- Default connection: `default`, `SCM_ANALYTICS_SA_NONSENSITIVE` on `scm_analytics_load_medium`, DB `SCM_ANALYTICS`, `externalbrowser` auth.
- Other configured connections: `staging` (same account, `SCM_ANALYTICS_STAGING`), plus any per-project connections visible via `snow connection list`.
- First command in a session may open the browser for SAML login; the session token is cached after.

### Running queries

```bash
# Ad-hoc query against the default connection
snow sql -q "SELECT CURRENT_ROLE(), CURRENT_WAREHOUSE()"

# Use a specific connection (e.g. staging / clone DB)
snow sql -c staging -q "SELECT CURRENT_DATABASE()"

# Override role/warehouse/db inline (useful for ACCOUNT_USAGE queries)
snow sql --role ACCOUNTADMIN --warehouse <wh> --database SNOWFLAKE \
  -q "SELECT COUNT(*) FROM ACCOUNT_USAGE.ACCESS_HISTORY WHERE QUERY_START_TIME > DATEADD(day, -1, CURRENT_TIMESTAMP())"

# Read from a file: better for anything multi-statement or heredoc-unfriendly
snow sql -f analysis/my_query.sql

# Machine-readable output for scripts / summarization
snow sql -q "..." --format=json
snow sql -q "..." --format=csv
```

### Tips

- For `ACCOUNT_USAGE` / `INFORMATION_SCHEMA` queries, be explicit about role and warehouse; the default `SCM_ANALYTICS_SA_NONSENSITIVE` role won't see cross-database access history.
- Prefer `--format=json` when piping into `jq` or the Read tool; the default table format wraps and truncates wide columns.
- `snow sql -q` has a short timeout; for heavy analytical queries use `-f` so the CLI streams rather than buffering.

## Databricks CLI (`databricks`)

Installed via Homebrew (`databricks --version` → v0.297.2). Profiles visible via `databricks auth profiles`.

- Default profile: `hf-query-engine` → `https://hf-query-engine.cloud.databricks.com`.
- Auth is OAuth; runs `databricks auth login` once, then token caches in `~/.databrickscfg`.

### Running SQL and inspecting objects

```bash
# Find a SQL warehouse to target
databricks warehouses list --output json | jq '.[] | {id, name, state}'

# Run a query against a warehouse
databricks api post /api/2.0/sql/statements --json '{
  "warehouse_id": "<warehouse_id>",
  "statement": "SELECT current_catalog(), current_schema()",
  "wait_timeout": "30s"
}'

# Unity Catalog introspection
databricks catalogs list --output json | jq '.[].name'
databricks schemas list <catalog> --output json | jq '.[].name'
databricks tables list <catalog> <schema> --output json | jq '.[] | {name, table_type}'
databricks tables get <catalog>.<schema>.<table> --output json

# Jobs and runs
databricks jobs list --output json | jq '.[] | {job_id, settings: .settings.name}'
databricks jobs get-run <run_id> --output json
```

### Tips

- `system.access.table_lineage` is usually blocked (`INSUFFICIENT_PERMISSIONS`, no `USE SCHEMA` on `system.access`). Fall back to `information_schema.tables` / `information_schema.columns` per catalog for inventory work.
- Accessible `system.*` schemas are typically: `ai`, `data_classification`, `data_quality_monitoring`, `information_schema`. Downstream-pipeline lineage has to be reconstructed from repo-level search, not queried.
- For write-back / federated catalogs (`glue`, `public_glue`), the catalog is read-only from Databricks' side; don't try DML.
- Use `--output json` + `jq` for anything you plan to summarize; the default table output pads and wraps.

## AWS CLI (`aws`)

Installed (`aws --version` → aws-cli v2). Auth is HelloFresh SSO via the shared `hfsso` session (`https://hfsso.awsapps.com/start`, region `eu-west-1`). Config at `~/.aws/config`, which is a symlink to `~/dotfiles/aws/.aws/config` (the real, version-controlled file). No long-lived keys, no `~/.aws/credentials`; the SSO token caches under `~/.aws/sso/cache` after login.

### Logging in

```bash
# One browser login authorizes every profile that shares the hfsso session
aws sso login --profile sso-bi
aws sts get-caller-identity --profile sso-bi   # verify
```

The session token expires after a few hours; re-run `aws sso login` when calls start returning `Error loading SSO Token`.

### Profiles (accounts and roles)

All profiles use the `[sso-session hfsso]` block, so a single login covers them all.

| Profile | Account | Role | Use |
| --- | --- | --- | --- |
| `sso-bedrock` | `951719175506` bedrock1 | `bedrock-user` | Amazon Bedrock |
| `sso-bi` | `985437859871` main-bi | `developer` | **default for data work**; the SCM analytics + datalake S3 buckets |
| `sso-bi-developer` | `985437859871` main-bi | `BIDeveloper` | same S3 access as `sso-bi` |
| `sso-bi-poweruser` | `985437859871` main-bi | `PowerUserAccess` | broader main-bi access |
| `sso-it` | `489198589229` main-it | `main-it-developer` | main-it account |

Discover what's available with the cached token:

```bash
TOKEN=$(python3 -c "import json,glob; print([json.load(open(f)).get('accessToken') for f in glob.glob('$HOME/.aws/sso/cache/*.json') if 'accessToken' in json.load(open(f))][-1])")
aws sso list-accounts --access-token "$TOKEN" --region eu-west-1
aws sso list-account-roles --access-token "$TOKEN" --account-id <acct> --region eu-west-1
```

### S3 access map (SCM analytics)

Use `--profile sso-bi` (or set `AWS_PROFILE=sso-bi`). Envs in bucket names are `staging` and `live` (there is no `prod`/`production`).

| Bucket | Access via `sso-bi` | Notes |
| --- | --- | --- |
| `hf-group-intl-scm-analytics-<env>-nonsensitive` | yes | ISA curated outputs (`scm-analytics-engineers/`, etc.) |
| `hf-group-intl-scm-analytics-<env>-sensitive` | **no** | explicit deny in the bucket policy for all human SSO roles (PII); only the pipeline compute role gets in |
| `hf-datalake-<env>` | yes | shared HelloFresh datalake; Kafka topic events under `events/...` |
| `hf-isa-datalake-<env>-raw` | yes | ISA raw layer (e.g. `csat/interactions/...`) |

```bash
export AWS_PROFILE=sso-bi
aws s3 ls s3://hf-datalake-live/events/compensation_created/2026/06/25/12/
aws s3 cp s3://<bucket>/<key> - | head -c 400          # peek at object contents
```

### Tips

- The `sensitive` bucket cannot be inspected from any CLI profile (bucket-policy deny). To confirm raw formats there, read the pipeline `.conf` (`input.format`) or ask the pipeline owner; don't expect S3 list/get to work.
- A `NoSuchBucket` error means the env/name is wrong; an `AccessDenied` with "explicit deny in a resource-based policy" means the bucket exists but the role is blocked by policy (different from "no identity-based policy allows", which is a missing grant).
- Set `AWS_PROFILE` once per session instead of repeating `--profile`; it's already exported to `sso-bedrock` by default in the shell, so override it explicitly for data work.

## Jira (`jira` CLI)

Use the `jira` CLI (jira-cli, configured for project ISA at `~/.config/.jira/.config.yml`, token from `JIRA_API_TOKEN`). Do not use the Atlassian MCP.

```bash
jira me                                    # verify auth / show current user
jira issue list -q "project = ISA AND status = 'In Progress' AND assignee = currentUser()" \
  --order-by created --reverse --plain     # filter via JQL; order via flags, never inline ORDER BY
jira issue list -q "project = ISA" --raw   # JSON for parsing / summarizing
jira issue view ISA-123 --comments 5
jira issue create -tTask -s "Summary" -T body.md -a luis.aceituno@hellofresh.com -l "impact:cost_reduction"
jira issue comment add ISA-123 -T comment.md
jira issue move ISA-123 "In Progress"      # transition
jira issue assign ISA-123 luis.aceituno@hellofresh.com
jira issue link ISA-1 ISA-2 Blocks
```

Conventions:

- Put the description (and long comments) in a markdown file and pass it with `-T file.md`. jira-cli converts Markdown to Jira markup, so the old MCP `\n`-escaping quirk no longer applies.
- Every ticket description must end with the **Business Impact** block defined in the canonical spec above (same heading, same three fields, same allowed categories). Add it on updates if missing.
- Add the review-taxonomy labels with `-l` (repeat the flag per label). They are identical to the GitHub ones (colon, no space): the required `impact:<category>` labels (one per category in the **Category** field, usually one) and the required `scope:` label, plus the recommended `estimate:` and `kind:` labels from **Review labels (taxonomy)** above. Jira labels cannot contain spaces, which is why the whole taxonomy is colon-no-space.
- Wrap every file path, SQL identifier, column name, and code token in backticks (bare underscores render as emphasis otherwise). Do not use Markdown link syntax `[text](path)` for local file references; list the path in a code span.
- JQL ordering: jira-cli rejects inline `ORDER BY`; use `--order-by <field> [--reverse]`.
- After create/update, fetch back with `jira issue view <KEY>` and confirm the body and Business Impact block render as intended.

## Confluence (`curl` REST)

Reach Confluence through the REST API with `curl`. The Atlassian account token in `JIRA_API_TOKEN` authenticates Confluence too (Atlassian Cloud tokens are account-wide), so no separate secret is needed. Do not use the Atlassian MCP.

```bash
AUTH="luis.aceituno@hellofresh.com:$JIRA_API_TOKEN"
BASE="https://hellofresh.atlassian.net/wiki"

# Read a page with body (storage format) and current version
curl -s -u "$AUTH" "$BASE/rest/api/content/<page_id>?expand=body.storage,version" | jq .

# CQL search
curl -s -u "$AUTH" -G "$BASE/rest/api/content/search" \
  --data-urlencode 'cql=space = SCMAX AND title ~ "purchase order"' --data-urlencode 'limit=10' \
  | jq '.results[].title'

# Child pages of a parent
curl -s -u "$AUTH" "$BASE/rest/api/content/<parent_id>/child/page?limit=50" | jq '.results[] | {id, title}'
```

Reads via curl are straightforward. Writes are harder: the REST API takes Confluence **storage format** (XHTML), not Markdown (the MCP used to convert for us). For Markdown push, build the `confl` tool (tracked in the integration issue); until then write only simple pages hand-authored in storage format.

### Repos that mirror Confluence

Some docs repos (e.g. `99-meta/po-v2-consolidation/confluence/`) are a 1:1 mirror of Confluence pages. Each markdown file starts with YAML frontmatter binding it to the page:

```yaml
---
confluence_page_id: 6417678348
confluence_title: "2. Current Architecture"
confluence_parent_id: 6408667170   # omit for the landing page
confluence_space: SCMAX
---
```

Treat the page ID in frontmatter as authoritative. Don't look it up by title.

### Pushing edits (REST)

1. Read `confluence_page_id` and `confluence_title` from frontmatter; treat the page ID as authoritative.
2. GET the page (`?expand=version`) to capture the current `version.number`.
3. Strip the frontmatter block and the first H1 from the body (the title is set separately; leaving the H1 duplicates it).
4. Convert the body to storage format (XHTML), then `PUT $BASE/rest/api/content/<page_id>` with `Content-Type: application/json` and a payload that bumps `version.number` by 1:
   ```json
   {"id":"<page_id>","type":"page","title":"<confluence_title>",
    "version":{"number":<current+1>},
    "body":{"storage":{"value":"<xhtml>","representation":"storage"}}}
   ```
5. GET again and confirm the body rendered; some constructs (nested tables, raw HTML, certain emoji) don't survive conversion. Markdown-to-storage conversion is why a dedicated `confl` tool is the long-term answer for mirror-repo pushes.

### Rendering notes (verify after upload)

These apply when converting Markdown to storage format (via `confl` or by hand):

- Tables with very wide columns survive but render tightly; prefer concise cell content.
- Fenced code blocks work; specify the language (```` ```sql ````, ```` ```bash ````).
- Anchor-style links (`[foo](#section-heading)`) work inside the same page but only if the heading slug matches what Confluence generates. When in doubt, check after upload.
- Links to other mirrored pages: use the local relative path (`[page 4](04-pipeline-ops-intelligence.md)`) when iterating in the repo; Confluence resolves them to page links on upload **only if** the target page is in the same space and the ID is recognized, otherwise they end up as literal text. Prefer absolute Confluence URLs for cross-space or external links.
- Unicode dashes and arrows render fine; smart quotes usually do too.

### Useful endpoints

```text
GET  /rest/api/content/<id>?expand=body.storage,version       # read a page + body
GET  /rest/api/content/search?cql=<CQL>                       # CQL search
GET  /rest/api/content/<id>/child/page                        # child pages
GET  /rest/api/content/<id>/child/comment?expand=body.storage # comments
GET  /rest/api/content/<id>/history                           # version history
PUT  /rest/api/content/<id>                                   # update (see Pushing edits)
POST /rest/api/content                                        # create (see below)
```

### Creating new pages (REST)

```bash
curl -s -u "$AUTH" -X POST "$BASE/rest/api/content" -H 'Content-Type: application/json' --data @- <<'JSON'
{"type":"page","title":"<title>","space":{"key":"SCMAX"},
 "ancestors":[{"id":"<parent_id>"}],
 "body":{"storage":{"value":"<xhtml>","representation":"storage"}}}
JSON
```

- After creation, write the returned page ID back into the local file's frontmatter so future edits route correctly.

## Slack (`curl` Web API)

Reach Slack through the Web API with `curl`, using `SLACK_TOKEN` from `.env`. The configured token is a HelloFresh **user token** that authenticates (`auth.test` ok) but only carries **directory-read** scopes (`channels:read`, `groups:read`, `users:read`, `team:read`). It works for:

```bash
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'types=public_channel' --data-urlencode 'limit=20' \
  https://slack.com/api/conversations.list | jq '.channels[] | {id, name}'   # list channels
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'limit=20' \
  https://slack.com/api/users.list | jq '.members[] | {id, name}'             # list users
curl -s -H "Authorization: Bearer $SLACK_TOKEN" https://slack.com/api/auth.test | jq .  # identity
```

It **cannot** post, read message history, or search: `chat.postMessage`, `conversations.history`, and `search.messages` all return `missing_scope`. Messaging needs a token with `chat:write` (post), `channels:history` + `groups:history` (read history), and `search:read` (search) — a bot token covers post/history, a user token is required for search. Until such a token is configured, the **`slack` MCP plugin remains the messaging path** for Claude; pi has channel/user lookups only.

When a properly scoped token is set, the messaging recipes are:

```bash
# Post a message (needs chat:write)
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -H 'Content-type: application/json' \
  -d '{"channel":"#tribe-us-ops-analytics","text":"hello"}' \
  https://slack.com/api/chat.postMessage | jq '.ok'

# Read recent channel history (needs channels:history; channel ID, e.g. C0123456789)
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G \
  --data-urlencode 'channel=<channel_id>' --data-urlencode 'limit=20' \
  https://slack.com/api/conversations.history | jq '.messages[].text'

# Search messages (needs search:read, user token)
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'query=deploy failed' \
  https://slack.com/api/search.messages | jq '.messages.matches[].text'
```

Build a thin `slackcli` uv tool (md2gdoc-style) once a messaging-scoped token is in place and usage justifies it.

## HelloDev Knowledge Base

The internal KB is exposed only as an HTTP MCP endpoint (`hellofresh-kb`, `.../mcp/v2`) with no REST or CLI equivalent. It is reachable from Claude (MCP) only; pi has no path to it yet. This is the one sanctioned MCP under the CLI-first rule. If pi needs it, wrap it later via a pi MCP-bridge extension.
