# CLI Recipes (HelloFresh)

Detailed CLI recipes referenced from `../AGENTS.md`. The system map and auth table live in `../AGENTS.md` under **Connecting to HelloFresh Systems**.

## Snowflake CLI (`snow`)

Installed via Homebrew. Check `snow --version`. Config at `~/.snowflake/config.toml`.

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

Installed via Homebrew. Check `databricks --version`. Profiles visible via `databricks auth profiles`.

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
awslogin        # lazy: checks the cached session, only opens the browser when expired
```

`awslogin` (zsh function in `~/dotfiles/zsh/.zsh_config/funcs_aws.zsh`) wraps the manual flow below: it runs `aws sts get-caller-identity` first and skips the browser login when the session is still valid. One browser login authorizes every profile that shares the `hfsso` session, so the optional profile argument (`awslogin sso-bi`) rarely matters.

Manual equivalent:

```bash
aws sso login --profile sso-bi
aws sts get-caller-identity --profile sso-bi   # verify
```

The session token expires after a few hours; re-run `awslogin` (or `aws sso login`) when calls start returning `Error loading SSO Token`.

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
