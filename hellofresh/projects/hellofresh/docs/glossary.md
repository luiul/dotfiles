# HelloFresh Glossary

Shared org glossary for work under `~/projects/hellofresh`. Per the Ubiquitous Language rule in `../AGENTS.md`: a repo's own `docs/glossary.md` wins for that repo, this shared glossary comes next, generic usage comes last. The glossary centralizes terms from existing docs; it does not invent new ones. When a term is missing or ambiguous, propose an entry. Canonical after review.

## harvest

The local Business Impact database for Jira tickets and GitHub PRs: DuckDB + Apache Iceberg stored under `~/.harvest/` (repo: `~/projects/personal/harvest`, CLI: `harvest`). Harvest is the source of truth for all six impact fields; the Jira ticket and the GitHub PR are projections. Jira and GitHub are the sources of truth for lifecycle (status, resolution, PR states, reviews, comments), which `harvest sync` ingests. Dollar figures and estimate basis never appear on Jira.

Source: `../AGENTS.md`, Canonical record: harvest, and the harvest README (https://github.com/luiul/harvest).

## Business Impact fields

Six fields per ticket: Category, Estimated Annual Impact, Estimate Basis, Notes, Scope, Work Type. Four are projected to the Jira description block (`**Category:**`, `**Notes:**`, `**Scope:**`, `**Work Type:**`, in this fixed order, values in backticks). Estimated Annual Impact (a dollar figure) and Estimate Basis are harvest-only: they reveal infra spend and efficiency figures, so they live only in the private harvest store. On GitHub PRs the taxonomy lives only in labels; PR bodies never carry the block.

Source: `../AGENTS.md`, Business Impact (required on all Jira tickets) and Keep it parseable.

## Category (review taxonomy)

One or more of: `cost_reduction`, `risk_mitigation`, `increased_revenue`. Default to a single best fit; list multiple only when the change genuinely delivers on more than one axis, each defensible in Notes. GitHub label form: `impact:<category>`, one label per listed category.

Source: `../AGENTS.md`, Business Impact, Rules and Review taxonomy.

## Estimate Basis (review taxonomy)

Exactly one, harvest-only: `validated` (confirmed against real billing or metrics), `modeled` (computed from a stated model and assumptions), `speculative` (rough judgment, no model). Never written on Jira. When a figure is later confirmed, update the harvest row and flip the `estimate:` label on GitHub. GitHub label form: `estimate:<basis>`.

Source: `../AGENTS.md`, Review taxonomy.

## Scope (review taxonomy)

Exactly one per ticket: `squad`, `tribe`, `alliance`, `org`, in increasing order of reach. Blast radius of the change. Current org mapping: `org` = HelloFresh (Organization), `alliance` = No Alliance Operations Technology (Alliance), `tribe` = Operations Data and Decisions (Tribe), `squad` = Data Engineering (Squad). Pick the widest level the change actually affects. GitHub label form: `scope:<reach>`.

Source: `../AGENTS.md`, Review taxonomy.

## Work Type (review taxonomy)

Exactly one per ticket: `delivery` (ships a feature, dataset, or pipeline that directly serves a business need), `enablement` (platform, tooling, or framework work that unlocks other teams or engineers), `reliability` (hardens an existing system: DQ, monitoring, incident fixes, resilience), `maintenance` (keeps the lights on: dependency bumps, refactors, migrations, cleanup). Orthogonal to Category. Pick the single best fit. GitHub label form: `work_type:<type>`.

Source: `../AGENTS.md`, Review taxonomy.

## clone DB

A per-PR Snowflake database created from `STAGING_US_OPS_ANALYTICS` for dev and QA of schemachange changes. Query it with the `US_OPS_ANALYTICS_DEV` role. It is dropped automatically on merge or PR close.

Source: `../AGENTS.md`, Schemachange, CI/CD Flow.

## schemachange script types

Three SQL script kinds managed by the schemachange tool in `us-ops-analytics-schemachange`: Versioned (`VX.X.X__filename.sql`, runs once, cannot be modified after merge), Always (`A__filename.sql`, runs every deployment), Repeatable (`R__filename.sql`, runs when content changes). Filenames allow only numbers, dashes, and dots, with a `.sql` extension.

Source: `../AGENTS.md`, Schemachange, SQL Script Naming.

## Tardis

The Airflow platform that runs dbt and Spark tasks on EMR on EKS (DAGs live in the `tardis-community` repo). There is no Tardis Airflow REST API or service account, and the Airflow UI redirects to Azure AD sign-in. Task logs are mirrored to S3 (`hf-tardis-logs-live`, `hf-tardis-logs-staging`, `hf-tardis-logs-dev` in the `main-bi` account) and are readable with `aws s3 ls` and `aws s3 cp`, no login needed.

Source: `docs/tardis-airflow-logs.md` (this folder).
