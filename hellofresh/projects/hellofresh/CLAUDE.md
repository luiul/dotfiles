# HelloFresh Project Instructions

## Branch Naming

Enforced org-wide by Mergeable (validated against Jira API).

Use the format: `type/TICKET-description`

- Types (must be one of): `major`, `minor`, `patch`, `issue`, `hotfix`, `feature`, `release`
- Ticket format: `ABC-123` (uppercase letters, dash, numbers) — validated against Jira, must be uppercase
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
  ```

- **Assignee**: always assign to me
- **Labels**: always add `squad: scm-analytics-engineers` and `tribe: intl-scm-analytics`
- No emoji prefixes in title or body
- No Claude Code links or attribution
- Omit empty sections rather than writing "N/A"
- Focus on the "why", not a list of every file changed

### Org-wide PR rules (enforced by Mergeable)
- PR description cannot be empty
- Title cannot contain "WIP" (use Draft PR instead)
- PR cannot have a "WIP" label
- Requires developer review approval

## Commits

- Complete all file changes before staging or committing — let the user review first
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`)
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`
- Do NOT add `Co-Authored-By` lines

## Schemachange (us-ops-analytics-schemachange)

This repo uses the schemachange tool to manage Snowflake objects.

### SQL Script Naming
- Versioned: `VX.X.X__filename.sql` (e.g. `V1.1.1__filename.sql`) — runs once, cannot be modified after merge
- Always: `A__filename.sql` — runs every deployment
- Repeatable: `R__filename.sql` — runs when content changes
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

## Snowflake CLI (`snow`)

Installed via Homebrew (`snow --version` → Snowflake CLI v3.16.0). Config at `~/.snowflake/config.toml`.

- Default connection: `default` — `SCM_ANALYTICS_SA_NONSENSITIVE` on `scm_analytics_load_medium`, DB `SCM_ANALYTICS`, `externalbrowser` auth.
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

# Read from a file — better for anything multi-statement or heredoc-unfriendly
snow sql -f analysis/my_query.sql

# Machine-readable output for scripts / summarization
snow sql -q "..." --format=json
snow sql -q "..." --format=csv
```

### Tips

- For `ACCOUNT_USAGE` / `INFORMATION_SCHEMA` queries, be explicit about role and warehouse — the default `SCM_ANALYTICS_SA_NONSENSITIVE` role won't see cross-database access history.
- Prefer `--format=json` when piping into `jq` or the Read tool; the default table format wraps and truncates wide columns.
- `snow sql -q` has a short timeout — for heavy analytical queries use `-f` so the CLI streams rather than buffering.

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

- `system.access.table_lineage` is usually blocked (`INSUFFICIENT_PERMISSIONS` — no `USE SCHEMA` on `system.access`). Fall back to `information_schema.tables` / `information_schema.columns` per catalog for inventory work.
- Accessible `system.*` schemas are typically: `ai`, `data_classification`, `data_quality_monitoring`, `information_schema`. Downstream-pipeline lineage has to be reconstructed from repo-level search, not queried.
- For write-back / federated catalogs (`glue`, `public_glue`), the catalog is read-only from Databricks' side — don't try DML.
- Use `--output json` + `jq` for anything you plan to summarize; the default table output pads and wraps.

## Jira

- The `description` field in `mcp__mcp-atlassian__jira_create_issue` / `jira_update_issue` takes **Markdown with real newlines**, not `\\n` literals. The MCP server converts Markdown to wiki markup. Double-escaped `\\n` sequences render as visible `\n` text in Jira.
- Wrap every file path, SQL identifier, column name, and code token in backticks. Bare underscores inside Markdown get interpreted as emphasis and rendered as `*` (e.g. `supplier_sku` must be `` `supplier_sku` ``).
- Do not use Markdown link syntax `[text](path)` for local file references — list the path in a code span instead.
- After creating a ticket, fetch it back with `jira_get_issue` (fields=description) and verify the first lines render as intended. If you see literal `\n` text, re-submit.

## Confluence

Use the `mcp-atlassian` MCP tools (`mcp__mcp-atlassian__confluence_*`) for all Confluence reads/writes.

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

### Pushing edits

1. Read `confluence_page_id` and `confluence_title` from frontmatter.
2. Strip the frontmatter block and the first H1 from the body before sending (the page title is already set by `confluence_title`; leaving the H1 in duplicates it).
3. Call `confluence_update_page` with `content_format="markdown"`, `enable_heading_anchors=false`.
4. After updating, fetch with `confluence_get_page` to confirm the body rendered as intended — the MCP server converts Markdown to storage format and some constructs (nested tables, raw HTML, certain emoji) don't survive the conversion.

### Markdown quirks to know

- Tables with very wide columns survive but render tightly — prefer concise cell content.
- Fenced code blocks work; specify the language (```` ```sql ````, ```` ```bash ````).
- Anchor-style links (`[foo](#section-heading)`) work inside the same page but only if the heading slug matches what Confluence generates. When in doubt, check after upload.
- Links to other mirrored pages — use the local relative path (`[page 4](04-pipeline-ops-intelligence.md)`) when iterating in the repo; Confluence will resolve them to page links on upload **only if** the target page is in the same space and the MCP tool recognizes the ID — otherwise they end up as literal text. Prefer absolute Confluence URLs for cross-space or external links.
- Unicode dashes and arrows render fine; smart quotes usually do too.

### Common reads

```
confluence_get_page          # by page_id — the normal read
confluence_get_page_children # list child pages of a parent
confluence_search            # CQL search, e.g. space = SCMAX AND title ~ "purchase order"
confluence_get_comments      # inline + page comments
confluence_get_page_history  # version history for a page
```

### Creating new pages

- Use `confluence_create_page` with `space_key`, `title`, `parent_id`, `content`, `content_format="markdown"`.
- After creation, write the returned page ID back into the local file's frontmatter so future edits route correctly.
