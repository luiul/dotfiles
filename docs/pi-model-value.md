# Pi Model Value Checks

Measured on 2 November 2026 with Pi 1.5.0 and the current AI Model Router catalog.

## Decision

Use router GPT-6.1 Terra at high thinking as the global daily model, following the user's choice of GPT-style output. Keep GLM 5.3 high as the budget alternative. The fixtures do not show Terra is always cheaper. Keep GPT-6 Luna low for narrow Explore work. General-purpose and Plan inherit the main model; no automatic planner/executor pipeline was added. Kimi K3 remains available in the full catalog.

The six scoped favorites are Terra, Sol, GLM, Luna, Argon and GLM Flash. Roles are Daily, Think, Budget, Quick, Vision and Helper. Sol starts at medium; Terra, GLM and Argon start at high; Luna starts at low; GLM Flash starts with thinking off. The apartment project inherits the global scope but preserves Argon high as its default.

Use GLM 5.3 Flash off for bounded review, explicit web summaries, and Hermes maintenance. Use GPT-6 Luna low for curator query rewriting. Normal web search keeps workflow `none` and automatic provider fallback. Blackhole routing and concurrency limits are unchanged.

## Configuration dependencies

[Grove](https://github.com/luiul/grove) owns the router catalog and display names in `~/projects/personal/grove/store.json` and `overlay.json`. The dotfiles model snapshot matches those files. At recovery review, both Grove files remained uncommitted. Preserve and review that source change before publishing this snapshot or regenerating from a clean Grove checkout. A dotfiles commit alone does not preserve the catalog source.

Argon resolves from the live discovered catalog in `~/.pi/agent/models-store.json`. Pi 1.5.0's bundled Vertex catalog does not contain it. A fresh installation needs successful catalog discovery before the Vision favorite can resolve. The model-role test uses a synthetic Argon record, so that test does not prove fresh-install availability.

## Usage Evidence

CodeBurn's 30-day exports show that coding, conversation, and exploration dominate this setup. Pi model rows and unique session rows both sum to about $1,238. The overview headline reports $688 and differs from its own per-tool totals. These are local usage records, not a verified billing total. No total from the authenticated adoption dashboard was available.

Image reading is a special case for apartment work, not the main benchmark weight.

## Matched Fixtures

All models used the same tools, prompt, source files, acceptance checks, and temporary output-token cap. Calls ran through Pi, not direct vendor APIs. The harness counted every assistant turn's reported cost, including cache writes, tool loops, and failed tool attempts. It disabled extensions and live memory for isolation. Six common fixtures covered promise caching, nested config merge, latest-row SQL, scheduling constraints, sourced price comparison, and approval/publication review. Two harder fixtures covered alias cycles and incremental history repair. Three repeated fixtures used a stable reference prompt of about 42,000 tokens.

| Matched group | Model and effort | Passed | Reported cost |
| --- | --- | --- | --- |
| Six common tasks | GLM 5.3 high | 6/6 | $0.02664 |
| Six common tasks | Kimi K3 high | 6/6 | $0.09001 |
| Six common tasks | Terra high | 6/6 | $0.05300 |
| Two harder tasks | GLM 5.3 high | 2/2 | $0.03987 |
| Two harder tasks | Kimi K3 high | 2/2 | $0.05009 |
| Two harder tasks | Terra high | 2/2 | $0.01939 |
| Three large-prompt tasks | GLM 5.3 high | 3/3 | $0.13050 |
| Three large-prompt tasks | Kimi K3 high | 3/3 | $0.30280 |
| Three large-prompt tasks | Terra medium | 3/3 | $0.18824 |
| All GLM/Kimi matched runs, including repeats | GLM 5.3 high | 14/14 | $0.20714 |
| All GLM/Kimi matched runs, including repeats | Kimi K3 high | 14/14 | $0.48400 |

GPT-6 Luna low and GLM 5.3 Flash off each passed the same three bounded admin/review checks. Their totals were $0.00145 and $0.00166.

Follow-up Sol checks passed all eight fixtures at both medium and high. Sol medium cost $0.08529, Sol high $0.10311, GLM high $0.06650, Kimi high $0.14010 and Terra high $0.07239 on those eight tasks. The three large-prompt Sol medium tasks cost $0.37428. Sol is not a proven cheaper replacement for GLM, and high did not improve fixture correctness over medium.

The 70 fixture runs reported about $1.568 total, below the $5 cap. Live summary, query rewrite, and isolated Hermes review checks added about $0.000274. These figures exclude this supervising conversation and research agents. Provider-reported usage is an estimate, not invoice verification.

## Limits

These are small synthetic tasks based on observed work types, not replayed production tickets. All larger models passed; the suite does not prove one model has higher general intelligence. Cold and warm cache state vary. The large-prompt fixture is synthetic. Do not extrapolate these results into guaranteed monthly savings or a universal cost per completed task. Repeat on real work before widening any role.

The initial price-comparison scorer required the literal winner `B`; valid responses used `Source B` or its URL. The check was corrected consistently for all models without extra model calls.

## Verification

Native display aliases preserve model IDs, request APIs, endpoint routing, token limits, pricing, and input metadata. They add no extension, model, or automatic request. Interactive checks cover all six favorites, role filtering, Tab → all and startup thinking levels. Autocomplete can expand a command before submission; press Escape to submit the filter unchanged.

A real Agent call used Explore with `GPT-6 Luna`, low thinking, one tool call, and the correct module-name result. General-purpose and Plan remain inherited defaults. No automatic paid reviewer or multi-agent pipeline was added.

`node scripts/test-pi-model-roles.mjs` checks aliases and helper config. `node scripts/test-hermes-review.mjs` checks the real installed review handler against an isolated loopback provider, including fallback and shutdown. Keep its configurable model and package paths, which also test the private Hermes hardening candidate. Live calls verified web summary, query rewriting, and one Hermes preference write with the six-model scope in an isolated store. They did not write test preferences to live memory.

The compact-scope tmux check verified all six selections and effort levels, Tab access to Kimi outside favorites, the apartment's inherited scope, and a real Terra high `read` call with live extensions. The pinned DeepSeek worker answered outside favorites. A Blackhole run recorded a valid `om.observations.coverage` event with no new observation; this proves an empty coverage run, not a nonempty memory write. Production worker config stayed unchanged.

Raw benchmark records remain in `/tmp/pi-model-value-3a46bS/results.json` and the fixture harness is `/tmp/pi-model-value-3a46bS/benchmark.mjs`. Temporary records can disappear after reboot; this document preserves the checked aggregate evidence.
