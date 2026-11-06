# Pi memory hardening

This setup keeps Pi, existing providers, installed packages, skills, and session history. The change improves the evidence sent to Hermes and narrows routine search. It does not isolate work and personal data or change provider routing.

## Ownership

Reviewed instruction files own standing rules and approval gates. Skills own reusable procedures. Hermes owns durable preferences and lessons. Pi session history owns the original conversation evidence. Context Mode indexes large outputs and documents. Blackhole remains unchanged.

Task progress stays in the session and approved issue or ticket, not durable memory. Current files and verified tool results override recalled facts. A retrieved lesson is context, not permission to act.

## Reviewer evidence

User, assistant, and tool-result records keep distinct labels and source entry IDs. System prompts and thinking are excluded. Content is JSON-quoted, so embedded role labels cannot create a new transcript record. This is evidence framing, not a complete prompt-injection defense.

User text keeps up to 16,000 characters. Longer text keeps both ends and an explicit omission marker. Assistant and tool text keep 500 characters, with both ends and an omission marker. Review instructions forbid inferring facts from omitted text or treating assistant claims as user preferences.

Background reviews process unseen records in oldest-first batches capped at 48,000 characters. A positive `reviewRecentMessages` setting limits batch size without acknowledging omitted records. Only a validated direct review whose operations all succeed advances the active-branch checkpoint. A valid empty operations decision advances it. Blank output, errors, cancellation, and subprocess completion do not. Branch navigation cancels the review. Original session entries remain intact.

Compaction and shutdown flushes retain their existing behavior and use the improved record framing. They are not incremental in this phase.

## Search scope

`memory_search` defaults to the current project plus global preferences and lessons. `target=user` defaults to globals. `target=project` defaults to the current project. `scope=global` requests global-only records. `scope=all` explicitly searches other projects. An explicit `project` filter remains supported and cannot be combined with `scope=all` or `scope=global`.

Legacy `session_search` defaults to the current repository. It resolves indexed session working directories rather than trusting basename labels, so nested repository sessions remain discoverable. Explicit `project` filters keep their prior label semantics. `scope=all` searches all indexed sessions. Empty scoped results never widen silently.

The opt-in anchor session-search mode keeps its existing explicit Markdown interface. Search scopes are relevance controls, not access-control boundaries. Global memories may still contain poorly scoped historical records. Providers and retention are unchanged.

## Patch lifecycle

The patch supports Hermes 0.9.11 and 0.10.0 only, with a separate reviewed source-hash manifest for each. All eight patched upstream source files are byte-identical between these versions. The 0.10.0 port keeps the same behavior and rejects other releases or source drift. It records the actual package version in the marker. `pi-memory-hardening` validates the package version and reviewed source hashes without writing. Application needs explicit approval and stopped affected Pi sessions:

```sh
pi-memory-hardening --approved
```

Do not apply from a disposable source checkout to the live package. Review and publish first, then run the command from the live dotfiles checkout during an agreed idle window. Existing Pi sessions need a restart or idle reload after application.

Application stages files, serializes patch writers, preserves baseline source, and writes the marker last. Source drift fails closed. If application is interrupted, `pi-memory-hardening --recover --approved` accepts only a provably dead owner and known staging bytes. A live or reused PID, unknown owner, or unknown bytes requires manual inspection. Do not remove recovery locks just because they are old. A package update removes the patch. Revalidate before reapplying; an unsupported version needs review, not relaxed guards. The baseline contains package code only, never memory or credentials.

## Verification

```sh
bun scripts/test-resource-budget.ts
node scripts/test-hermes-hardening.mjs
node scripts/test-hermes-patch-recovery.mjs
node scripts/test-hermes-interactive.mjs
node scripts/bench-hermes-hardening.mjs
```

The hardening suite uses private package copies and memory stores. The interactive check uses a bounded agent-owned tmux session and a fixed local provider. The benchmark alternates seven measured baseline and candidate pairs after warm-up, with identical package layouts and private settings.

## Hermes 0.10.0 port checks

The port passed 17 hardening checks, 18 existing review checks, exact-version and recovery checks, 18 resource-budget checks, and a real isolated Pi 1.5.0 TUI check. Tests verify all eight installed target files remain unchanged. Recovery fixtures simulate the older version through package metadata because the patched source hashes are identical; they do not test a separate 0.9.11 runtime installation.

Four seven-pair foreground benchmark runs on 6 November 2026 produced these startup medians:

| Run | Baseline | Candidate |
| --- | --- | --- |
| First | 1382 ms | 1399 ms |
| Repeat | 1422 ms | 1433 ms |
| Shell run | 1489 ms | 1587 ms |
| Reversed starting order | 1508 ms | 1517 ms |

Foreground turn medians stayed between 5.72 and 5.92 ms. Candidate RSS differences ranged from 1.4 MiB lower to 3.6 MiB higher. Paired startup differences in the reversed-order run ranged from 464 ms faster to 306 ms slower. These results are inconclusive for a strict no-performance-loss claim. On 6 November 2026, the user accepted a possible small startup cost for the verified memory-correctness benefit. This scoped tradeoff permits rollout after the other activation checks pass; it is not proof of zero overhead. The benchmark disables review and does not exercise searches, so background and large-index costs remain outside these measurements. `--candidate-first` reverses the initial order and reports paired startup differences.

A bounded startup investigation measured the actual Pi extension loader with temporary in-memory instrumentation. Six balanced pairs showed configuration medians of 0.31 ms baseline and 0.29 ms candidate, registration medians of 2.19 and 2.16 ms, and import medians of 270.09 and 287.62 ms. The paired import delta median was 14.24 ms. Unchanged host preamble and persistence work varied much more. A separate same-process import probe suggested 8.49 ms extra import time, but its order was imbalanced and a balanced replacement timed out. These supporting results suggest a small import cost; they do not prove its cause. The accepted tradeoff replaces the strict timing gate for this rollout only. No further whole-host repeats are needed without a new hypothesis.

The optional paid evidence check needs explicit approval:

```sh
node scripts/eval-hermes-evidence.mjs --approved-paid
```

It uses synthetic content, the configured reviewer, bounded output, and a reported $3 ceiling. It never writes memory. Small fixture results do not prove general coding quality or universal absence of performance regressions.
