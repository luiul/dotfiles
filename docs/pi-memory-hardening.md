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

The patch supports Hermes 0.9.11 only. `pi-memory-hardening` validates the package version and reviewed source hashes without writing. Application needs explicit approval and stopped affected Pi sessions:

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

The optional paid evidence check needs explicit approval:

```sh
node scripts/eval-hermes-evidence.mjs --approved-paid
```

It uses synthetic content, the configured reviewer, bounded output, and a reported $3 ceiling. It never writes memory. Small fixture results do not prove general coding quality or universal absence of performance regressions.
