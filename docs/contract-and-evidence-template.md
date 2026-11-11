# Contract and verification evidence

Use this template for a shared dataset, API, migration, or other high-risk behavior change.
Keep it short and copy only relevant fields into the existing ticket or PR.
It does not create a new tracker or approve a production action.

## Contract

| Field | Define before implementation |
| --- | --- |
| Owner and consumers | Who owns the output, and who depends on it? |
| Grain and identity | What uniquely identifies a row or resource? |
| Time and lifecycle | What do effective time, arrival time, deletions, and reruns mean? |
| Public shape | Which names, types, precision, ordering, and metadata must stay compatible? |
| Allowed differences | Which source corrections or new rows may change the output? |
| Forbidden differences | Which missing keys, cleared values, changed arrays, or overwritten metadata must block release? |
| Runtime and cost | Which warehouse, volume, runtime, and resource limits are acceptable? |
| Rollout and recovery | Who approves promotion? How is bad output contained and recovered? |

Do not confuse preservation with correctness.
Keeping old values can be right for an additive fix, but wrong for a valid source deletion or correction.
Specify those decisions instead of silently retaining or dropping data.
Never put secrets, private source records, spend estimates, or credentials in an org-wide ticket or PR.
HelloFresh impact figures and estimate basis stay in Harvest.

## Evidence

| Acceptance criterion | Check command or query path | Outcome | Scope and limits | Evidence |
| --- | --- | --- | --- | --- |
| Example: stored keys retained | Baseline anti-join | Pass, fail, blocked, or not run | Fixture, sample, full dataset, or live | Code SHA, input snapshot, restricted log or artifact |
| Example: populated values retained | Per-column baseline comparison | State exact losses | Include nested values and approved exceptions | Query IDs or result artifact |
| Example: late arrival handled | Actual incremental merge fixture | State expected and observed values | Tests final stored state, not only candidate SQL | Test command and results |
| Example: runtime acceptable | Bounded shadow build | Record duration and resource use | Data volume and warehouse | Query ID and effective timeout |
| Example: consumer output correct | Export or API comparison | State exact differences | Internal model versus delivered output | Relevant artifact |

Bind evidence to the exact reviewed commit and source snapshot.
If either changes, rerun affected checks.
Use sanitised fixtures with independently specified expected values.
For a critical assertion, inject a known defect in an isolated fixture and prove the check rejects it.
A test that agrees with the implementation can still encode the same wrong assumption.

## Release decision

- List unresolved warnings, skipped checks, and their reasons.
- State which checks are mandatory before promotion and who owns each blocker.
- Separate review readiness, commit, publication, merge, and live deployment.
- Confirm the effective server-side timeout, sandbox write targets, and any live read dependencies.
- Compare a candidate with control output on identical frozen inputs before changing shared data.
- Define stop conditions and a recovery plan. Code rollback alone may not repair bad persisted data.

A sample proves only that sample.
An unenforced metadata constraint is not a data-quality check.
No finite test suite guarantees all business semantics; the goal is explicit, reproducible release evidence.

## Pilot: recipe and recipe history

[The recipe pilot](https://hellofresh.atlassian.net/browse/GLOA-890) keeps its checks in `tardis-community` under `pipelines/intl-scm-analytics/scm-analytics-engineers/dbt/scripts/`.
Use `verify_recipe_history.py` for real state transitions and `verify_recipe_contract.py` for frozen baseline comparisons.
Run `test_verify_recipe_contract.py` for deliberate contract-failure checks without a warehouse.
Its full-volume runtime and complete-dataset comparison remain separate release gates.
These task-specific checks are a pilot, not a generic framework or proof that the migration is deployable.

## Sources

- [dbt contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts) define shape, not all output semantics.
- [dbt unit tests](https://docs.getdbt.com/docs/build/unit-tests) do not prove the final incremental merge.
- [Google SRE data pipelines](https://sre.google/workbook/data-processing/) covers shadow runs, rollout, and data recovery.
- [DORA test automation](https://dora.dev/capabilities/test-automation/) favors reliable, maintainable checks.
