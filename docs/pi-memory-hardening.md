# Pi memory hardening

This setup keeps Pi, existing providers, installed packages, skills, and session history. The change improves the evidence sent to Hermes and narrows routine search. It does not isolate work and personal data or change provider routing.

## Ownership

Reviewed instruction files own standing rules and approval gates. Skills own reusable procedures. Hermes owns durable preferences and lessons. Pi session history owns the original conversation evidence. Context Mode indexes large outputs and documents. Blackhole remains unchanged.

Task progress stays in the session and approved issue or ticket, not durable memory. Current files and verified tool results override recalled facts. A retrieved lesson is context, not permission to act.

## Reviewer evidence

User, assistant, and tool-result records keep distinct labels and source entry IDs. System prompts and thinking are excluded. Content is JSON-quoted, so embedded role labels cannot create a new transcript record. This is evidence framing, not a complete prompt-injection defense.

User text keeps up to 16,000 source characters. Longer text keeps both ends and an explicit omission marker. Assistant and tool text keep 500 source characters. The encoded record budget includes JSON escaping and omission markers. Entry IDs, timestamps and tool names each have a 1,024-character JSON budget, with explicit head and tail omissions. Exact IDs still drive checkpoints in the original session. Every record and every joined background evidence batch stays within 48,000 characters. Review instructions forbid inferring facts from omitted text or treating assistant claims as user preferences.

Background reviews process unseen records in oldest-first batches capped at 48,000 characters. A positive `reviewRecentMessages` setting limits batch size without acknowledging omitted records. Only a validated direct review whose operations all succeed advances the active-branch checkpoint. A valid empty operations decision advances it. Blank output, errors, cancellation, and subprocess completion do not. Branch navigation cancels the review. Original session entries remain intact.

Compaction and shutdown flushes retain their existing behavior and use the improved record framing. They are not incremental in this phase.

## Search scope

`memory_search` defaults to the current project plus global preferences and lessons. `target=user` defaults to globals. `target=project` defaults to the current project. `scope=global` requests global-only records. `scope=all` explicitly searches other projects. An explicit `project` filter remains supported and cannot be combined with `scope=all` or `scope=global`.

Legacy `session_search` defaults to the current repository. It resolves indexed session working directories rather than trusting basename labels, so nested repository sessions remain discoverable. Explicit `project` filters keep their prior label semantics. `scope=all` searches all indexed sessions. Empty scoped results never widen silently.

The opt-in anchor session-search mode keeps its existing explicit Markdown interface. Search scopes are relevance controls, not access-control boundaries. Global memories may still contain poorly scoped historical records. Providers and retention are unchanged.

## Patch lifecycle

The patch supports Hermes 0.9.11 and 0.10.0 only, with a separate reviewed source-hash manifest for each. The eight essential upstream transforms remain. Revision `hermes-evidence-scope-v2` adds two reviewed child-lifecycle targets and rejects newer npm versions. Legacy `hermes-evidence-scope-v1` validation remains read-only. Do not mutate a rolling copy, even with `--approved`. `pi-memory-hardening` validates the selected package without writing. For a non-rolling package, application needs explicit approval and stopped affected Pi sessions:

```sh
pi-memory-hardening --approved
```

Do not apply from a disposable source checkout to the live package. Review and publish first, then run the command from the live dotfiles checkout during an agreed idle window. Existing Pi sessions need a restart or idle reload after application.

Application stages files, serializes patch writers, preserves baseline source, and writes the marker last. Source drift fails closed. If application is interrupted, `pi-memory-hardening --recover --approved` accepts only a provably dead owner and known staging bytes. A live or reused PID, unknown owner, or unknown bytes requires manual inspection. Do not remove recovery locks just because they are old. A package update removes the patch. Revalidate before reapplying; an unsupported version needs review, not relaxed guards. The baseline contains package code only, never memory or credentials.

## Rolling activation while agents run

To avoid changing code under running agents, prepare a separate exact-version copy:

```sh
node scripts/prepare-hermes-rolling.mjs --approved
node scripts/test-hermes-rolling.mjs
node scripts/activate-hermes-rolling.mjs --approved
```

The new copy lives at `~/.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v2`. Active `0.10.0-evidence-v1` stays unchanged. Preparation verifies an existing destination before checking installed npm, so a later inactive npm upgrade does not break idempotence. If v2 is missing, preparation restores reviewed baseline files only inside a new private copy of v1 and applies v2 there. An unsupported npm release is never upgraded or patched implicitly. Source manifests check all package source files and reject drift or unexpected files. Verification is not a continuous runtime guard. Tests use private copies and never prepare in the live agent directory. Runtime dependencies are copied, not linked to stores or credentials.

Trusted central HelloFresh intake must disable npm, v1 and v2 before activation. Activation fails closed if that separately owned override is missing. Implementation repos keep the selected local package enabled. Activation resolves the managed `current-version` runtime, not a hardcoded release or stale symlink. It holds Pi's global settings lock, replaces only known Hermes source entries, preserves custom scope filters by refusing to overwrite them, and retains a revision-specific settings backup. Existing sessions are not reloaded. Memory locations, retention, providers and history stay unchanged. The rollout does not repair or delete stores.

The local package is pinned and does not auto-update. Run preparation before restoring these settings on a new machine. An npm update does not update this local copy. A newer Hermes release needs a new reviewed versioned copy and matching central override, not silent mutation of the active path.

Activation uses Pi's settings lock and changes only the Hermes package entries. It preserves other fields and saves the original settings next to the copied package. The regression checks that a stale Pi session saving another setting does not overwrite the new package entries.

Rollback changes the two Hermes package entries back to the original npm source. Keep the versioned copy while any session may still use it. Do not delete stores to roll back code.

## Child lifecycle and repair

The POSIX watchdog uses a live shell group anchor and a control pipe. A valid root exit status triggers immediate cleanup of the still-owned group, then drains queued output. Normal and nonzero exits do not wait for the cancellation grace period. Timeout and cancellation retain TERM cleanup and the 500 ms KILL escalation, even if descendants replace themselves or close output streams. Watchdog death closes the anchor pipe, which kills its own group. A private host-owned Unix socket detects Pi host death without PID polling. Both primary and fallback child invocations use it. The workload cannot inherit the control pipe or status fd. INT and QUIT dispositions reset before workload exec. Self-detaching descendants that create new groups are outside this ownership boundary. Windows fallback fails closed because this pinned POSIX design is not a Windows job object.

`pi-memory-repair.sh` keeps its public command but defaults to read-only integrity and count checks. It never edits npm or rolling source and never deletes backups, corrupt databases or forget snapshots. A checkpoint requires `--checkpoint --approved --backup-dir NEW_DIRECTORY`. Stop writers first. The command retains a verified SQLite backup, fails on corrupt input, and reports a busy checkpoint. It does not promise to repair corruption. Example:

```sh
pi-memory-repair.sh
pi-memory-repair.sh --checkpoint --approved --backup-dir "$HOME/retained-hermes-checkpoint"
```

## Verification

```sh
bun scripts/test-resource-budget.ts
node scripts/test-hermes-hardening.mjs
node scripts/test-hermes-fixes.mjs
node scripts/test-hermes-patch-recovery.mjs
node scripts/test-hermes-rolling.mjs
node scripts/test-hermes-interactive.mjs
node scripts/bench-hermes-hardening.mjs --validate-only
```

The hardening suite uses private package copies and stores. The interactive check uses the maintained private Rex driver and a fixed local provider on Pi 1.6.0. The v2 checks reproduce v1 overflow and surviving descendants before asserting the fix. They cover timeout, cancellation, root exit, descendant turnover, watchdog death, host death, nonzero status, stdin EOF, signal reset, recovery and rollout guards.

The benchmark compares active hardened v1 with private candidate v2 on the same current Pi 1.6.0. It uses one discarded warmup pair and at least seven rotated measured pairs. Reports include raw samples, medians, MAD, paired deltas, source manifests, CLI and report hashes. Startup, five foreground turns, two-second idle CPU and RSS, and ordinary and escape-heavy evidence collection have separate results. Stores and settings are private. There are no API calls. Background review and large-index search costs are not measured.

Run sequentially after integration, with no concurrent performance tests. Preserve two new reports:

```sh
node scripts/bench-hermes-hardening.mjs --pairs 7 --output /tmp/hermes-v2-baseline-first.json
node scripts/bench-hermes-hardening.mjs --pairs 7 --candidate-first --output /tmp/hermes-v2-candidate-first.json
```

The child-latency benchmark compares the active v1 watchdog with candidate v2. It measures success, nonzero exit and buffered output separately. Each workload gets one discarded warmup pair and at least seven sequential rotated pairs. Reports preserve exact source hashes, raw samples, medians, MAD, paired deltas and output integrity checks. It uses private fixtures and no credentials or model calls:

```sh
node scripts/bench-hermes-child.mjs --validate-only
node scripts/bench-hermes-child.mjs --pairs 7 --output /tmp/hermes-child-v2-baseline-first.json
node scripts/bench-hermes-child.mjs --pairs 7 --candidate-first --output /tmp/hermes-child-v2-candidate-first.json
```

Recovery preflight includes the complete staged marker bytes, including version, revision and file hashes. Unknown marker bytes preserve all source staging and the owner lock. A known interrupted marker publication can retry without an `EEXIST` collision.

Investigate median latency growth above 5%, timing MAD above 5% of baseline, paired RSS growth above 10 MiB, or measured candidate idle CPU. A noisy run is inconclusive, not proof of zero cost. The repair and rollout work is tracked at [issue 111](https://github.com/luiul/dotfiles/issues/111), evidence and lifecycle at [issue 110](https://github.com/luiul/dotfiles/issues/110), and combined review at [issue 112](https://github.com/luiul/dotfiles/issues/112).

The 24 November 2026 sequential check on Pi 1.6.0 compared active hardened v1 with candidate v2. Seven rotated pairs after warmup gave startup medians of 763 ms (MAD 8 ms) and 783 ms (MAD 24 ms). The paired startup delta median was minus 0.6 ms, so this does not establish a startup regression or win. Foreground medians were 2.31 ms and 2.29 ms. Candidate RSS was about 0.6 MiB higher. Two-second idle samples were below the 10 ms CPU resolution. These fixtures disable background review and do not measure large-index searches.

The child path has a measured safety cost. Two reversed-order runs measured a normal v1 child at about 141 ms and v2 at about 165 ms. The new anchor and signal-reset shim add about 20 to 25 ms at subprocess start. Root completion-to-close stayed near 5 to 6 ms, rather than waiting for the 500 ms cancellation grace. Success, nonzero status and 3 MiB buffered output preserved their output. This is not a zero-overhead result. Accept that cost before live rollout. Ordinary evidence collection stayed near its baseline; escaping-heavy evidence costs more to enforce the serialized bound. Reports and fixture limits belong to [the combined review](https://github.com/luiul/dotfiles/issues/112).

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
