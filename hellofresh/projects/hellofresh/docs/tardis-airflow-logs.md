# Tardis Airflow: Pulling Task Logs from S3

Referenced from `../AGENTS.md`. The `sso-bi` profile and S3 access map live in `cli-recipes.md` (same folder).

Tardis DAGs (`tardis-community` repo) run dbt/Spark tasks on EMR on EKS. There is no Tardis Airflow REST API / service account (an open ask, tracked in DATAPLAT-3048), and the Airflow UI (`https://tardis-airflow.dwh-k8s.hellofresh.io` live, `...dwh-staging-k8s...` staging) redirects to Azure AD sign-in and cannot be curled/scripted. **But the Airflow task log content is mirrored to S3 and fully readable via `aws s3 ls`/`cp` alone, no interactive login needed** (confirmed 2026-08-11). Only reach for the manual UI Log-tab step if you don't have (and can't guess) the DAG id.

## Fastest path: pull the Airflow task log straight from S3, no UI login

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

## Fallback (UI session already open): read the IDs from the Airflow task log, then pull from S3

1. Open the failing task's **Log** tab in the Airflow UI (the DAG grid link with `tab=logs`).
2. Near the top of the log, find lines like:
   - `Found virtual cluster name = <vc_name> id = <vc_id>`
   - `Start Job Run success - Job Id <job_id> and virtual cluster id <vc_id>`
3. Pull the raw Spark driver/executor logs straight from S3 (same `sso-bi` profile as the S3 access map in `cli-recipes.md`):

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

## Last resort: time-window brute force (only when the dag_id can't be guessed or discovered)

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

## Other troubleshooting resources

- **Grafana Loki** (same driver logs, queryable once you have the `job_id`, no S3 path needed): `{cluster="platform-dwh-spark-<env>-eks", app=~".*<job_id>.*", container="spark-kubernetes-driver"} |= ""` at `prdhellofresh.grafana.net` (live) / `stghellofresh.grafana.net` (staging).
- **General Tardis Airflow infra troubleshooting** (pod health, DAG import errors, `kubectl` commands, Airflow CLI via `vault-env`): the `tardis-airflow` runbook on HelloDev, mirrored in `hellofresh/runbooks` at `troubleshooting/data-platform/data-fusion/airflow/tardis-airflow.md`.
- Escalation: Data Streaming and Operations (Data Platform on-call); the Fusion/Tardis team owns the Airflow infra but doesn't always have permissions for every downstream issue.

## Known gotcha: `is_first_run=False` / "Target table ... not found" on a pipeline's genuine first run

A rewritten/renamed pipeline (old `_ap`-suffixed table, or a prior unversioned DAG) can fail its real first run with `is_first_run=False` even though the exact new destination table has never been written (confirmed clean in S3/Glue/Snowflake). The false negative comes from a **stale sibling Glue table** (old name, same `Service`/`pipeline_name` tags) that the old DAG left behind without dropping. Renaming the DAG's own version suffix (`_v3` -> `_v4`) does **not** fix this (confirmed empirically). The actual fix: find and drop the stale sibling table/S3 data (`aws glue get-tables ... contains(Name, ...)` to find it, `aws glue delete-table` + S3 `rm`/lifecycle; or check `gh workflow list` for an existing "Data Cleanup" GitHub Action in the repo first). Full diagnostic procedure: the `diagnose-tardis-first-run-checkpoint-mismatch` skill in tardis-community.
