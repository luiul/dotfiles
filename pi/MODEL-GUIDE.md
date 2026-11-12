# Scoped model guide

`/model-guide` compares the current session's scoped models without selecting one. Native `/model`, Tab, model cycling and default selection stay unchanged. The seven global favorites are Terra high (Daily), Kimi K3.1 Pro high (Code), Sol medium (Think), GLM high (Budget), Luna low (Quick), Argon high (Vision) and GLM Flash off (Helper). Terra remains the default.

## Use

Open `/model-guide` to compare two models. The left column starts with the active scoped model. The right column starts with the next favorite. Left/right chooses the column to edit, and up/down cycles through the actual scope. The columns stay distinct when more than one model is scoped. A one-model scope shows that model on both sides.

PageUp/PageDown pages the matrix while its model headers stay visible. Each metric stays on one page when it fits. Oversized source fields get a continuation label. Press `d` to toggle technical evidence. Press `/` to find a model by provider, model ID, role or purpose, then Enter to set the comparison column. Escape cancels search without closing the guide. `/model-guide think` starts with the matching model in the right column. Outside search, Escape or Enter closes without selecting a Pi model or writing settings.

The matrix separates task fit, intelligence and catalog rates from local fixture outcomes. It uses clear metric rows and two model columns, not an all-model ranking. The layout caps its width at 112 columns. Cells wrap, and short terminals page the body. Below 40 columns, the guide asks for a larger terminal instead of compressing text into unreadable columns.

The comparison respects the actual session scope, including project settings and command-line `--models` overrides. It does not keep a second favorites list. An unscoped session shows a message rather than the full catalog. Unknown scoped models remain usable in the guide, with unknown evidence and no curated purpose.

## Data ownership

- Session scope supplies membership and order.
- Resolved models supply canonical identity, native role and purpose, catalog rates and context limits. Router display names remain owned by [Grove](https://github.com/luiul/grove) `overlay.json`.
- Effective settings supply per-model thinking pins. An inline scope pattern takes precedence over a model pin. Only the active model shows actual current thinking. Unpinned models are labelled unpinned; Pi applies its own default/current fallback and capability clamping when selected.
- `pi/.pi/agent/model-guide.json` is the sole source of guide benchmark evidence. It stores public score evidence and optional local fixture snapshots with dates, test effort, checked counts, measured estimated spend, timeout counts and sources. It does not store membership, roles, catalog rates or context limits. Grove's older intelligence data remains separate and is not used by the guide.

Matching effort does not prove matching provider behavior. Kimi's published effort is unverified. GLM's available max score is not a high score. Flash's reasoning-version score is not an off score. Missing or mismatched evidence is labelled unknown. The review date is shown without an automatic expiry rule. Future dates are flagged. Invalid records are ignored, while valid records and catalog fields remain available.

Prices are catalog values per million tokens, not costs per successful task or verified invoices. Zero is displayed as a catalog value, not free usage. Flat prices can omit long-context tiers and other provider charges. Argon's intelligence score is not a vision benchmark. No overall ranking is calculated.

## Local workflow evidence

The [November snapshot](https://github.com/luiul/dotfiles/issues/105#issuecomment-6829658619) records the seven models at their configured effort. Six small runs comprise four automated offline code checks, one SQL query and one constraint review. The SQL and review outputs were inspected separately, not scored as six automated passes. GLM's review included an unsupported dirty-file-location claim, which remains a caveat.

Small batch spend includes all six runs. Mean small-run spend divides that batch by six, not by an invented success count. The Grove test is one real profile-selection bug repeated without execution or test feedback. Hidden regression checks judge each patch after the model finishes. Spend per passing patch includes failed attempts and divides total spend by passing patches. No passing patch means the value is undefined, not zero; the total failed-attempt spend remains visible. Argon timed out once and was not repeated.

These are Pi estimates from configured rates, not invoices or general cost per production task. No vision benchmark is included. Results at another configured effort show not tested. A future local snapshot is not used. Bad local records are dropped without losing valid public scores or catalog data.

## Runtime

The extension registers one command. It adds no tool, prompt content, model calls, native patch, selection hook, network refresh, timer, watcher or worker. The command loads its view and reads evidence only when opened. Search and rendering use the resulting local snapshot. The guide writes nothing. The footer remains compact; its role matcher recognizes Code so Kimi retains its canonical identity.

Semantic theme colors distinguish section headings and evidence warnings. Scores stay neutral. Labels remain readable without color. Metric rows align both model values for direct comparison. Tiny surfaces show an enlarge-terminal hint with working close keys.

## Verification

From the dotfiles source worktree:

```sh
bun scripts/test-model-guide.ts
node scripts/test-pi-model-roles.mjs
node scripts/test-model-guide-live.mjs
```

The live test needs `rex` on PATH and the maintained private Rex driver. If the CLI is not on PATH, use a private test-only symlink to the installed Rex app helper; do not install or replace the shared command. It starts separate servers, not desktop sessions. Provider fixtures are local and do not call vendors. It checks command prompt parity, guide behavior, native picker behavior, Kimi effort and footer identity, CLI scope and themes. Cleanup failures fail the test. Unit checks include malformed evidence, unknown models, effort precedence and terminal bounds.

## Baseline measurements

These measurements apply to the published list/detail baseline, not a speed claim for the pair matrix.

On 12 November 2026 with Pi 1.5.1, the final seven-pair rotated process fixture reported a median of 514.2 ms without the guide and 525.3 ms with it. Median absolute deviations were 0.9 ms and 7.2 ms. This interval includes startup, one local fixture completion and shutdown; it is not isolated startup latency. Earlier runs varied, so these samples do not establish a speed improvement or a stable regression.

The first guide wait-to-frame sample was 161.1 ms. Seven repeated command-to-frame samples had a median of 221.7 ms, including terminal input and capture. These boundaries differ and are not a cold/warm speed comparison. Both baseline and guide processes showed no measurable CPU-time increase over four idle seconds at `ps` resolution of 0.01 seconds. One RSS sample was 165,392 KiB without the guide and 158,832 KiB with it; memory varied substantially across runs and is not a measured saving.

Fourteen real Pi fixture requests had identical prompt strings and tool sets with the extension absent or loaded. Opening, searching, scrolling and closing the guide made no provider requests. Tests covered native scope switching, Kimi high selection, footer identity, CLI and project scopes, dark and light themes, 40-column and 12-column terminal layouts, and private fixture shutdown. This is isolated real Pi verification, not deployment to the user's existing interactive sessions.

## Pair-matrix verification

The pair regression check failed against the published list view, then passed after the matrix change. Unit checks cover independent column changes, collision handling, unknown and future evidence, empty/singleton/two-model scopes, search, paging, close behavior and both themes. The matrix remained bounded across widths from 1 to 160 columns and terminal heights from 5 to 50 rows. Strict TypeScript and the existing 78-check footer suite passed.

A private Rex run with Pi 1.5.1 checked the pair keys, search, local cost cells, technical sources, 40-column paging, 12-column fallback, CLI effort overrides and project scope. Fourteen local-provider requests still had identical prompts and tools with the command loaded or absent. Guide interactions made no provider requests. Both idle Pi samples were below the four-second CPU measurement resolution of 0.01 seconds. The matrix render check was about 0.26 to 0.29 ms per render over 1,000 renders; it is a local microbenchmark, not user-perceived latency.

The owned Ghostty preview was reloaded and its viewport showed Terra and Kimi in the two-column matrix. It uses local stub responses, not vendor calls, and retains its original two-hour deadline. Live global settings remained unchanged. These checks verify the source candidate, not global deployment.

Implementation, publication and live deployment are separate. The source worktree does not automatically replace the dirty live checkout. Settings use the live file vs snapshot pattern; merge only the reviewed scope and thinking changes into the live file, then refresh its snapshot without losing other package or runtime changes.
