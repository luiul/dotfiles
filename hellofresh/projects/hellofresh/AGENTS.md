# HelloFresh Project Instructions

These instructions apply to every repo under the subfolders of `~/projects/hellofresh` (`01-generation/`, `02-ingestion/`, `03-transformation/`, `04-serving/`, `05-orchestration/`, `06-governance-infra/`, `misc/`). When a repo has its own context file, the repo-specific guidance wins on conflicts.

## Planning & Tracking

HelloFresh repos do not have GitHub Issues enabled, so the global rule (track plans in GitHub issues) does not apply. Track bigger projects and multi-step plans as Jira tickets in project ISA, following the Business Impact conventions below. Use in-repo markdown only for working notes that are not ticket-worthy.

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
  ## TLDR
  2-4 plain-language sentences: what happened, why, and what the change does

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

- The **Business Impact** section is required on every PR (canonical spec below); it is never omitted, even when impact is small or indirect.
- **Open as draft**: always create PRs as drafts first (`gh pr create --draft`); leave it to me to mark them ready for review.
- **Assignee**: always assign to me.
- **Labels**: always add the squad and tribe labels `squad: scm-analytics-engineers` and `tribe: intl-scm-analytics` (the spaces are an org-wide convention), plus the review-taxonomy labels from **Review taxonomy** below: at minimum the required `impact:<category>` label(s) (one per Business Impact category) and the `scope:<reach>` label; add the recommended `estimate:` and `work_type:` labels where they apply. Create missing labels first (e.g. `gh label create "impact:cost_reduction" --description "Year-end review: cost reduction" --color 0E8A16`). This lets the year-end review filter by label as well as by heading (`gh pr list --label "impact:cost_reduction" --state all`). GitHub PRs only: on Jira the same taxonomy lives in the Business Impact body block, since a Jira automation strips custom labels off tickets.
- No emoji prefixes in title or body.
- No agent attribution, tool footers, or generated-by links (no Claude Code or pi credits).
- Omit empty sections rather than writing "N/A".
- Focus on the "why", not a list of every file changed.
- **TLDR first**: the body always starts with a `## TLDR` section, written for a reader with no context on the system (what happened, why, what the change does).
- **Concise, not exhaustive**: plain language plus, when it clarifies the issue, one small concrete example (a few sample rows or a short query result). Do not dump full investigation logs, long JSON payloads, or every query that was run; those belong in the linked Jira ticket. The PR body is the friendly summary, not the full report.

### Org-wide PR rules (enforced by Mergeable)
- PR description cannot be empty
- Title cannot contain "WIP" (use Draft PR instead)
- PR cannot have a "WIP" label
- Requires developer review approval

## Business Impact (required on all PRs and Jira tickets)

Every PR I open and every Jira ticket I create or update across all repos under this directory must carry a Business Impact block. This feeds the end-of-year review, so the format is fixed and must stay machine-parseable. The block lives in the body/description and includes the review taxonomy (scope, estimate basis, work type) as body fields. On GitHub PRs the taxonomy is also applied as labels; on Jira the body fields are the only record (a Jira automation strips custom labels off tickets).

### Canonical block

Use exactly these fields, in this order, with these field labels. The first three are the core block; the last three carry the review taxonomy (defined under **Review taxonomy** below):

```markdown
## Business Impact
- **Category:** `cost_reduction`, `risk_mitigation`
- **Estimated Annual Impact:** $120,000
- **Notes:** Removed duplicate DQ coverage, cutting Soda scan compute (cost) and reducing on-call triage / false-alert risk (risk).
- **Scope:** `tribe`
- **Estimate Basis:** `modeled`
- **Work Type:** `reliability`
```

### Rules

- **Category** is one or more of: `cost_reduction`, `risk_mitigation`, `increased_revenue`, each wrapped in backticks. Default to a single best-fit category. List multiple (comma-separated, primary driver first) only when the change genuinely delivers on more than one axis (e.g. a migration that both cuts compute cost and removes a data-loss / outage risk); each one listed must be defensible in Notes.
- **Estimated Annual Impact** is a dollar estimate of annualized business impact, formatted `$` + number with thousands separators (e.g. `$0`, `$12,500`, `$1,200,000`). Use `$0` only for genuinely zero-dollar work (e.g. pure refactors) and explain why in Notes. Never leave it blank or write "N/A" / "TBD".
- **Notes** is one or two sentences justifying the category (or each, when more than one) and the dollar figure (what drives the number, what assumptions).
- Never use the tilde `~` for "approximately" in the block (or in PR/ticket Markdown generally): GitHub and Jira parse `~text~` as strikethrough, silently striking everything between two tildes. Write "about", "approx", or "roughly" instead.
- This section is never omitted, even though other sections are omitted when empty.
- **Scope**, **Estimate Basis**, and **Work Type** are the review-taxonomy fields defined below. Always fill them in (each value in backticks); they are part of the block on every PR and ticket.
- Always ask me for the category and dollar estimate if you cannot infer them confidently from the change. Do not silently guess a large number.

### Review taxonomy

The review taxonomy (impact category, scope, estimate basis, work type) is recorded as **GitHub PR labels** in `dimension:value` colon-no-space form (`impact:cost_reduction`, `scope:tribe`, `estimate:modeled`, `work_type:reliability`) and, in parallel, as **body fields** in the Business Impact block (`**Category:**`, `**Scope:**`, `**Estimate Basis:**`, `**Work Type:**`), each value in backticks. On GitHub both forms are present; on Jira only the body fields survive (the label-stripping automation), so do not apply taxonomy labels there. The org-wide `squad: ` / `tribe: ` labels (with their space) are a separate convention, not part of this taxonomy.

- **Category** (`**Category:**` field, required, one or more): `cost_reduction`, `risk_mitigation`, `increased_revenue` (defined above). GitHub label form: `impact:<category>`, one per listed category.
- **Scope** (`**Scope:**` field, required, exactly one): `squad`, `tribe`, `alliance`, `org`, in increasing order of reach. Blast radius of the change; maps to leveling rubrics (scope of influence), so reviewers weigh it alongside dollars. My current org hierarchy: `org` = HelloFresh (Organization), `alliance` = No Alliance Operations Technology (Alliance), `tribe` = Operations Data and Decisions (Tribe), `squad` = Data Engineering (Squad). Pick the widest level the change actually affects. GitHub label form: `scope:<reach>`.
- **Estimate Basis** (`**Estimate Basis:**` field, recommended, one): `validated` (confirmed against real billing/metrics), `modeled` (computed from a stated model and assumptions), `speculative` (rough judgment, no model). Protects credibility: a validated figure defends itself, a speculative one is flagged as such. GitHub label form: `estimate:<basis>`.
- **Work Type** (`**Work Type:**` field, recommended, exactly one): `delivery`, `enablement`, `reliability`, `maintenance`. The type of work, orthogonal to dollar impact (which **Category** captures). `delivery` ships a feature, dataset, or pipeline that directly serves a business need; `enablement` is platform/tooling/framework work that unlocks other teams or engineers (the force-multiplier axis leveling rubrics reward, even when its own dollar line is indirect); `reliability` hardens an existing system (DQ, monitoring, incident fixes, resilience); `maintenance` keeps the lights on with no new capability (dependency bumps, refactors, migrations, cleanup). Pick the single best fit. Kept separate from **Category** on purpose: a change can be `cost_reduction` + `enablement` at once. GitHub label form: `work_type:<type>`.

Record one **Category** value per category (usually one, occasionally more), exactly one **Scope**, at most one **Estimate Basis**, and at most one **Work Type** in the body. On GitHub PRs, mirror these as labels and create any missing label first (`gh label create "<label>" --description "..." --color <hex>`). When a `speculative` or `modeled` figure is later confirmed, update the Notes with the actual, flip **Estimate Basis** to `validated`, and (on GitHub) flip the `estimate:` label.

### Keep it parseable

The year-end review harvests these blocks programmatically (the harvest and reporting tooling lives in the `promo-tracker` repo, not here). All that matters on the authoring side is that the block stays machine-readable:

- Keep the heading text exactly `## Business Impact`.
- Keep the field labels exactly `**Category:**`, `**Estimated Annual Impact:**`, `**Notes:**`, `**Scope:**`, `**Estimate Basis:**`, `**Work Type:**`.
- One field per line, in the fixed order above.
- Wrap every taxonomy value in backticks.

## Commits

- Complete all file changes before staging or committing; let the user review first.
- Use conventional commits: `type: short description` (e.g. `fix: venv info display`, `feat: add terminal keybindings`). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`, `test`.
- No `Co-Authored-By` lines.

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

- Always use `uv` for Python operations: `uv run` not `python`, `uv pip` not `pip`, `uv venv` not `python -m venv`, etc.

## GitHub

- Always use `gh` CLI for GitHub interactions (PRs, issues, checks, releases, etc.)

## Connecting to HelloFresh Systems

CLI-first. Reach every system through its CLI, or a documented `curl` REST recipe where no CLI exists. Use MCP only for capabilities that are MCP-native with no CLI/REST path (the HelloDev knowledge base), and only when I explicitly ask (see **HelloDev Knowledge Base** below). Never consult the HelloDev KB MCP eagerly or on your own initiative. All tokens live in `~/dotfiles/.env` and are exported into the shell by `.zshrc` (`set -a; source ~/dotfiles/.env`), so any command run here already sees them, including from pi.

| System | Tool | Auth |
| --- | --- | --- |
| GitHub | `gh` CLI | keyring (account `luiul`, intentional) |
| Jira | `jira` CLI | `JIRA_API_TOKEN` (env) |
| Confluence | `curl` REST | same Atlassian token as Jira (`JIRA_API_TOKEN`); Atlassian Cloud tokens are account-wide |
| Snowflake | `snow` CLI | browser SSO |
| Databricks | `databricks` CLI | OAuth |
| AWS (S3, etc.) | `aws` CLI | SSO (`hfsso` session, browser) |
| Google Docs | `md2gdoc` | service account |
| Slack | `slack` MCP server (pi, read-only, only path) + `curl` Web API (directory reads) | browser session tokens (xoxc+xoxd), re-extracted automatically per launch; `SLACK_TOKEN` (env) for directory reads |
| HelloDev KB | MCP (pi & Claude, via `pi-mcp-adapter`) | none required |

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

Installed (`aws --version` → aws-cli v2). Auth is HelloFresh SSO via the shared `hfsso` session (`https://hfsso.awsapps.com/start`, region `eu-west-1`). Config at `~/.aws/config`, a symlink to `~/dotfiles/aws/.aws/config` (the real, version-controlled file). No long-lived keys, no `~/.aws/credentials`; the SSO token caches under `~/.aws/sso/cache` after login.

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

## Tardis Airflow: Pulling Task Logs from S3

Tardis DAGs (`tardis-community` repo) run dbt/Spark tasks on EMR on EKS. There is no Tardis Airflow REST API / service account (an open ask, tracked in DATAPLAT-3048), and the Airflow UI (`https://tardis-airflow.dwh-k8s.hellofresh.io` live, `...dwh-staging-k8s...` staging) redirects to Azure AD sign-in and cannot be curled/scripted. **But the Airflow task log content is mirrored to S3 and fully readable via `aws s3 ls`/`cp` alone, no interactive login needed** (confirmed 2026-08-11). Only reach for the manual UI Log-tab step if you don't have (and can't guess) the DAG id.

### Fastest path: pull the Airflow task log straight from S3, no UI login

The Airflow task log (the exact content of the UI's Log tab, including the `Found virtual cluster name=...` / `Start Job Run success...` lines) lives at a predictable path and is fully discoverable by listing:

```bash
export AWS_PROFILE=sso-bi
ENV=live   # or staging

# 1. Discover the dag_id: list the whole prefix and grep for the pipeline's base name
#    (every DAG that has ever run has a dag_id=... folder here, including old/superseded
#    unversioned DAGs that were never actually paused; see the diagnose-tardis-first-run-
#    checkpoint-mismatch skill in tardis-community for why that matters).
aws s3 ls "s3://hf-tardis-logs-$ENV/tardis-airflow-$ENV/" | grep -i "<pipeline-base-name>"

# 2. Discover run_id under that dag_id (sorted, tail = most recent; a run_id list that stops
#    abruptly weeks ago tells you that DAG stopped running around then, without asking anyone).
aws s3 ls "s3://hf-tardis-logs-$ENV/tardis-airflow-$ENV/dag_id=<dag_id>/" | sort

# 3. Discover task_id/attempt under that run_id, then pull the log directly (quote the path;
#    run_id contains ':' and '+').
aws s3 ls "s3://hf-tardis-logs-$ENV/tardis-airflow-$ENV/dag_id=<dag_id>/run_id=<run_id>/" --recursive
aws s3 cp "s3://hf-tardis-logs-$ENV/tardis-airflow-$ENV/dag_id=<dag_id>/run_id=<run_id>/task_id=<task_id>/attempt=<n>.log" - 2>&1
```

The task log gives you the `job_id`/`virtual_cluster_id` (for the Spark driver log path below) plus things the driver log lacks: the real `execution_date`, `AIRFLOW_CTX_TRY_NUMBER`, and `Starting attempt N of M`. That lets you tell a genuinely fresh dataset-triggered DagRun apart from one quietly retrying for days with parameters baked in at creation (a real gotcha: `is_first_run`/`prev_timestamp`-style task params are computed once per DagRun, not re-derived per retry).

### Fallback (UI session already open): read the IDs from the Airflow task log, then pull from S3

1. Open the failing task's **Log** tab in the Airflow UI (the DAG grid link with `tab=logs`).
2. Near the top of the log, find lines like:
   - `Found virtual cluster name = <vc_name> id = <vc_id>`
   - `Start Job Run success - Job Id <job_id> and virtual cluster id <vc_id>`
3. Pull the raw Spark driver/executor logs straight from S3 (same `sso-bi` profile as the S3 access map above):

```bash
export AWS_PROFILE=sso-bi
ENV=live   # or staging
BUCKET=hf-tardis-logs-$ENV
VC_NAME=<vc_name>   # format: hf-tardis-<tribe>-<squad>-<env>, abbreviated if the name is too long
VC_ID=<vc_id>
JOB_ID=<job_id>

# Driver stdout/stderr: start here, this is where the dbt/Spark error shows up
aws s3 cp "s3://$BUCKET/$VC_NAME/logs/$VC_ID/jobs/$JOB_ID/containers/spark-$JOB_ID/spark-$JOB_ID-driver/stdout.gz" - | gunzip | less
aws s3 cp "s3://$BUCKET/$VC_NAME/logs/$VC_ID/jobs/$JOB_ID/containers/spark-$JOB_ID/spark-$JOB_ID-driver/stderr.gz" - | gunzip | less

# Executor logs are sibling folders under the same containers/spark-$JOB_ID/ prefix
aws s3 ls "s3://$BUCKET/$VC_NAME/logs/$VC_ID/jobs/$JOB_ID/containers/spark-$JOB_ID/"
```

Virtual cluster names confirmed for `intl-scm-analytics` (`aws s3 ls s3://hf-tardis-logs-live/ | grep scm`):
- `hf-tardis-intl-scm-analytics-scm-analytics-engineers-<env>` (scm-analytics-engineers squad)
- `hf-tardis-intl-scm-analytics-scm-biz-int-<env>`
- `hf-tardis-intl-scm-analytics-scm-ops-research-<env>`
- `hf-tardis-scm-tech-prc-assortment-personalization-<env>`

Buckets: `hf-tardis-logs-live`, `hf-tardis-logs-staging`, `hf-tardis-logs-dev`, all in the `main-bi` account (`985437859871`), reachable with the same `sso-bi` profile.

Task naming convention for dbt-based Tardis DAGs: `dbt_run.<model_name>.<run|test>` (Cosmos-style grouping, one Spark/EMR job per dbt task; a model's `run` and `test` steps are two separate jobs, each with its own `job_id`).

### Last resort: time-window brute force (only when the dag_id can't be guessed or discovered)

Without the job_id and without a discoverable dag_id under `tardis-airflow-<env>/`, binary-search the job folders under `.../jobs/` by `LastModified` (job ids sort roughly chronologically) and grep candidate driver stdout/stderr for the model/table name:

```bash
export AWS_PROFILE=sso-bi
BUCKET=hf-tardis-logs-live
VC_NAME=hf-tardis-intl-scm-analytics-scm-analytics-engineers-live
VC_ID=$(aws s3 ls "s3://$BUCKET/$VC_NAME/logs/" | awk '{print $2}' | tr -d /)  # one per squad cluster currently

# One `aws s3 ls` call lists every job folder (non-recursive PRE listing, paginates itself; ~150k
# entries as of Aug 2026 but still returns in ~20-30s; do NOT add --recursive, that walks every
# container file and can take many minutes)
aws s3 ls "s3://$BUCKET/$VC_NAME/logs/$VC_ID/jobs/" > /tmp/jobs_list.txt

# Binary-search by LastModified of the first object in each job folder
# (aws s3api list-objects-v2 --prefix .../jobs/<job_id>/ --max-items 1 --query 'Contents[0].LastModified')
# to find the index range matching your target time window, then grep each candidate driver
# stdout.gz/stderr.gz for the model/table name (e.g. "purchase_order_v2").
```

This is slow (one `list-objects-v2` probe per binary-search step; macOS bash has no `timeout`, so run long listings in the background with `&`/`sleep`/`wc -l` polling, or use `context_mode_ctx_execute`) and only narrows to "jobs that ran in this squad's cluster during the window"; it cannot pinpoint one task when several pipelines ran concurrently, and finds **nothing** if the task failed *before* job submission (an Airflow-level error, e.g. Vault/connection/pool issues, means no Spark job was ever created). Always prefer discovering the dag_id first (the fastest path above covers the large majority of cases with no manual UI step).

If no matching job turns up in the window, or the Airflow task log never reached the `Start Job Run` line, the root cause is in the Airflow task's own log (the worker container), which is still on S3 (fastest path above); read it directly instead of chasing Spark driver logs.

### Other troubleshooting resources

- **Grafana Loki** (same driver logs, queryable once you have the `job_id`, no S3 path needed): `{cluster="platform-dwh-spark-<env>-eks", app=~".*<job_id>.*", container="spark-kubernetes-driver"} |= ""` at `prdhellofresh.grafana.net` (live) / `stghellofresh.grafana.net` (staging).
- **General Tardis Airflow infra troubleshooting** (pod health, DAG import errors, `kubectl` commands, Airflow CLI via `vault-env`): the `tardis-airflow` runbook on HelloDev, mirrored in `hellofresh/runbooks` at `troubleshooting/data-platform/data-fusion/airflow/tardis-airflow.md`.
- Escalation: Data Streaming and Operations (Data Platform on-call); the Fusion/Tardis team owns the Airflow infra but doesn't always have permissions for every downstream issue.

### Known gotcha: `is_first_run=False` / "Target table ... not found" on a pipeline's genuine first run

A rewritten/renamed pipeline (old `_ap`-suffixed table, or a prior unversioned DAG) can fail its real first run with `is_first_run=False` even though the exact new destination table has never been written (confirmed clean in S3/Glue/Snowflake). The false negative comes from a **stale sibling Glue table** (old name, same `Service`/`pipeline_name` tags) that the old DAG left behind without dropping. Renaming the DAG's own version suffix (`_v3` -> `_v4`) does **not** fix this (confirmed empirically). The actual fix: find and drop the stale sibling table/S3 data (`aws glue get-tables ... contains(Name, ...)` to find it, `aws glue delete-table` + S3 `rm`/lifecycle; or check `gh workflow list` for an existing "Data Cleanup" GitHub Action in the repo first). Full diagnostic procedure: the `diagnose-tardis-first-run-checkpoint-mismatch` skill in tardis-community.

## Jira (`jira` CLI)

Use the `jira` CLI (jira-cli, configured for project ISA at `~/.config/.jira/.config.yml`, token from `JIRA_API_TOKEN`). Do not use the Atlassian MCP.

```bash
jira me                                    # verify auth / show current user
jira issue list -q "project = ISA AND status = 'In Progress' AND assignee = currentUser()" \
  --order-by created --reverse --plain     # filter via JQL; order via flags, never inline ORDER BY
jira issue list -q "project = ISA" --raw   # JSON for parsing / summarizing
jira issue view ISA-123 --comments 5
jira issue create -tTask -s "Summary" -T body.md -a luis.aceituno@hellofresh.com
jira issue comment add ISA-123 -T comment.md
jira issue move ISA-123 "In Progress"      # transition
jira issue assign ISA-123 luis.aceituno@hellofresh.com
jira issue link ISA-1 ISA-2 Blocks
```

Conventions:

- Put the description (and long comments) in a markdown file and pass it with `-T file.md`. jira-cli converts Markdown to Jira markup, so the old MCP `\n`-escaping quirk no longer applies.
- Every ticket description must end with the **Business Impact** block defined in the canonical spec above (same heading, same fields, same allowed values), including the `**Scope:**`, `**Estimate Basis:**`, and `**Work Type:**` taxonomy fields. On Jira the body is the only durable record (the automation strips custom labels), so the block must be complete. Add it on updates if missing.
- Do **not** add review-taxonomy labels (`impact:`, `scope:`, `estimate:`, `work_type:`) on Jira tickets; the automation removes them. Those labels stay on GitHub PRs only.
- Wrap every file path, SQL identifier, column name, and code token in backticks (bare underscores render as emphasis otherwise). Do not use Markdown link syntax `[text](path)` for local file references; list the path in a code span.
- JQL ordering: jira-cli rejects inline `ORDER BY`; use `--order-by <field> [--reverse]`.
- After create/update, fetch back with `jira issue view <KEY>` and confirm the body and Business Impact block render as intended.
- **Every ISA ticket must carry a `fixVersion` so it lands on board 11974** (Global Ops DE Scrum). The board's saved filter is `project = ISA AND fixVersion IN ("Engineering", "OR - Engineering", DPM)`; a ticket with no `fixVersion` (or one outside that list) is invisible on the board and backlog regardless of assignee, reporter, or status. Default to `Engineering` (version id `30557`) unless the ticket clearly belongs to `OR - Engineering` or `DPM`. Set it at creation time (`jira issue create` does not expose `--fix-version`, so follow up with the REST call below), and check for it whenever creating or editing a ticket assigned or reported by me:
  ```bash
  curl -s -u "luis.aceituno@hellofresh.com:$JIRA_API_TOKEN" -X PUT \
    "https://hellofresh.atlassian.net/rest/api/3/issue/ISA-XXXXX" \
    -H 'Content-Type: application/json' \
    --data '{"fields":{"fixVersions":[{"id":"30557"}]}}'
  ```
  To sweep for any of my tickets missing this (assignee or reporter = me), page through `POST /rest/api/3/search/jql` with `jql=project = ISA AND (assignee = currentUser() OR reporter = currentUser()) AND fixVersion is EMPTY` (the legacy `GET /rest/api/3/search` endpoint is removed; use `/rest/api/3/search/jql` with `nextPageToken` pagination), then PUT the fix above per key.

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

## Slack (`slack-mcp-server` MCP): READ ONLY, MCP-only, fully automatic

**Standing instruction: pi only reads Slack, never posts, and never requires manual steps for auth/fallback.** Never call `slack_conversations_add_message` (not even enabled, see below). No browser DevTools, no manual token capture, no slackcli: everything is one self-contained script.

**The only path: the `slack` MCP server**, wired natively into `~/dotfiles/pi/.pi/agent/mcp.json`; pi calls `slack_conversations_history`, `slack_conversations_replies`, `slack_conversations_search_messages`, and `slack_channels_list` directly, no CLI shelling-out. Backed by `korotovsky/slack-mcp-server` (npm global `slack-mcp-server@1.3.0`, tracked in `brew/Brewfile`), launched through a wrapper: `~/dotfiles/hellofresh/.local/bin/slack-mcp-server-hf` (stowed onto `PATH`). On every launch the wrapper pulls a fresh `xoxc`/`xoxd` browser session from the Slack **desktop app** via `slacktokens`, sets `SLACK_MCP_USER_AGENT` + `SLACK_MCP_CUSTOM_TLS=true` (the tool's Enterprise Grid anti-detection mitigation), and execs `slack-mcp-server`. The mcp.json entry passes:

- `-no-cache`: skips the startup users/channels cache build, the bulk fetch most likely to trip Enterprise Grid scraping detection per community reports. Tradeoff: `#channel-name`/`@user` lookups don't resolve, so always use channel/user **IDs**.
- `-enabled-tools` scoped to the four read tools only: `conversations_add_message` is deliberately excluded, so the write tool does not exist in this setup.

**`slackcli` is intentionally not part of pi's Slack setup.** It was previously documented as a fallback CLI, but it added a second concurrent consumer of the same live desktop-app cookie for no benefit (the MCP tools already cover read/search/list). Fewer concurrent consumers of one cookie means less exposure to the session-forking detection below. `slackcli` and its re-auth helper `slack-relogin` still exist in `~/dotfiles/hellofresh/.local/bin/` for ad-hoc manual use or Claude Code's separate fallback path, but pi does not use either.

This is a **different** integration from Claude's: Claude reaches Slack through a hosted OAuth MCP (`slack@claude-plugins-official` -> `https://mcp.slack.com/mcp`, enabled in `~/.claude/settings.json`'s `enabledPlugins`), which requires the workspace admin to have approved the MCP integration via OAuth (gated the same way KB000103 gates a custom Slack App). pi's own OAuth bridge to that hosted server was tried on 2026-07-13 and repeatedly failed ("invalid or expired state parameter" on the localhost callback), so pi uses self-hosted `slack-mcp-server` instead (browser-session auth, no OAuth/admin approval needed).

**Known issue, handled automatically rather than "fixed": the periodic "signed out of Slack, suspicious activity" logout.** Root cause: any tool replaying the desktop app's live session cookie is subject to HelloFresh Enterprise Grid's "session forking" anomaly detection (slack.engineering/catching-compromised-cookies), which flags one cookie used concurrently from two clients/TLS fingerprints as possibly stolen, auto-signs the session out, and emails the human "suspicious activity". Because it's one shared cookie, the kick-out hits the real desktop Slack app too. It can't be fully eliminated while requiring zero manual steps: true decoupling needs either (a) a separately-obtained browser session (one-time manual DevTools capture, explicitly out of scope) or (b) a dedicated read-only bot token via Slack Security review (KB000103), a multi-day/week process whose bot tokens can't read DMs or use `search.messages` at all (those scopes don't exist for bots), so it wouldn't fully replace this setup even if approved. **The applied fix: minimize concurrent cookie consumers** (dropped slackcli, above) **and make recovery automatic.** The MCP server is `lifecycle: lazy` in mcp.json, so it relaunches, re-extracting a fresh cookie via `slacktokens`, every time pi needs it; if a session dies mid-use, the next Slack read just works. **The only truly manual step left, unavoidable:** if Slack force-signs the account out server-side, sign back into Slack.app yourself (SSO/MFA can't be scripted); the next automatic launch picks up the fresh cookie.

**Evaluated `rusq/slackdump` as a replacement (2026-07-22), rejected.** It ships a TLS-fingerprint mitigation (PR #622) for exactly this detection, but it does not work against HelloFresh's Enterprise Grid tenant: `slackdump workspace import <env-file>` validates the `xoxc`/`xoxd` fine ("Workspace added and selected"), but the very next command (`slackdump list channels ...`, with and without `-enterprise`) immediately fails with `005 (Initialization Error): invalid_auth`, reproduced twice with freshly extracted credentials. Don't re-attempt without a newer release that specifically claims an Enterprise Grid auth fix.

**MCP tools available (all read-only):**

| Tool | Purpose |
|------|---------|
| `slack_conversations_history` (`channel_id`, `limit`) | Read recent channel/DM history |
| `slack_conversations_replies` (`channel_id`, `thread_ts`) | Read a specific thread |
| `slack_conversations_search_messages` (`query`) | Search messages |
| `slack_channels_list` | List channels |

Because of `-no-cache`, always pass channel IDs (e.g. `C0BFPQSFYLR`), not `#channel-name`/`@user` lookups. A Slack URL like `https://hellofresh.slack.com/archives/C0BFPQSFYLR` carries the channel ID as its last path segment.

**Directory reads (fallback): `curl` Web API** with `SLACK_TOKEN` from `.env`. This HelloFresh **user token** authenticates (`auth.test` ok) but carries only **directory-read** scopes (`channels:read`, `groups:read`, `users:read`, `team:read`). It works for:

```bash
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'types=public_channel' --data-urlencode 'limit=20' \
  https://slack.com/api/conversations.list | jq '.channels[] | {id, name}'   # list channels
curl -s -H "Authorization: Bearer $SLACK_TOKEN" -G --data-urlencode 'limit=20' \
  https://slack.com/api/users.list | jq '.members[] | {id, name}'             # list users
curl -s -H "Authorization: Bearer $SLACK_TOKEN" https://slack.com/api/auth.test | jq .  # identity
```

That token **cannot** read message history or search: `conversations.history` and `search.messages` return `missing_scope`. Use the `slack` MCP tools (above) for history/search.

## HelloDev Knowledge Base

The internal KB is exposed only as an HTTP MCP endpoint (`hellofresh-kb`, `.../mcp/v2`) with no REST or CLI equivalent. This is the one sanctioned MCP under the CLI-first rule.

**Do not consult the HelloDev KB / `kb_*` MCP tools eagerly.** Only query it when I explicitly ask (e.g. "check HelloDev", "ask the KB", "search the knowledge base"). For everything else, prefer the repo checkout, the CLIs/REST recipes above, and what is already in context. Do not reach for these tools on your own initiative just because a question is HelloFresh-related.

- Claude reaches it via the `hellofresh-kb` server in `~/.claude.json`.
- pi reaches it via [`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) (the `kb` server in `~/dotfiles/pi/.pi/agent/mcp.json`), which registers each MCP tool directly, prefixed `kb_` (e.g. `kb_search_internal_knowledge_base`). Run `/mcp` in pi to list bridged servers/tools. The endpoint is reachable on the corporate network without a token.

Note: this MCP serves the KB content, not the Backstage docs portal at `hellodev.hellofresh.io`. That portal is a JS SPA behind OAuth; `curl` only returns the app shell, and `/api/techdocs/*` is auth-gated. For docs that exist in a local repo checkout, read the repo copy instead.
