# Pi extensions

## Model scores companion

`model-scores/index.ts` is the additive `/model-scores` companion picker for issue #9. It leaves pi's native `/model` and Ctrl+P picker untouched.

The picker reads the current session scope, or the available authenticated model registry when the session is unscoped. It groups Bedrock route duplicates by canonical model ID, keeps exact provider and model identities for selection, displays route and invocation region separately, prefers the current `AWS_REGION`, and shows pi's all zero cost metadata as unknown. It writes a versioned runtime cache only under `~/.pi/agent/data/model-scores.json`, never into this stow package.

The cache uses schema version 1, exact `provider + modelId` keys, nullable unknown values, explicit readiness and freshness states, source status, a two second process lock, restrictive permissions, atomic replacement, and last known good cost preservation. `/model-scores sync` reconciles the current inventory and records a local snapshot without network access. `--provider=name` and `--region=name` filter the picker.

After selecting a model family, the detail view lets the user select an exact route. Successful selection calls `pi.setModel()` with that exact model object and reapplies a pinned thinking level with `pi.setThinkingLevel()`. A rejected `setModel()` keeps the selector open and informs the user.

`pi/.pi/agent/models.json` contains official Bedrock pricing overrides for 54 currently enabled model IDs whose family rates were verified against AWS sources. Route and regional differences are preserved where represented by the installed pi catalog. Configured IDs without verified official pricing are intentionally absent and render as unknown rather than free.

Verification from the repository root:

```sh
bunx vitest run pi/.pi/agent/extensions/model-scores-tests/model-scores-core.test.ts pi/.pi/agent/extensions/model-scores-tests/model-scores-cache.test.ts
pi --no-session --no-extensions -e pi/.pi/agent/extensions/model-scores/index.ts -p 'Reply with exactly OK.'
```

The print mode check verifies that the extension loads without opening the interactive picker. Use `/model-scores` from an interactive pi session to exercise the selector.


## ste-lite (lazy Simplified Technical English guard)

`ste-lite/` implements the plan in [issue #12](https://github.com/luiul/dotfiles/issues/12): a small, first-party pi extension that nudges assistant replies and file-edit prose toward ASD-STE100-style Simplified Technical English (short sentences, approved-word swaps, no filler/hedging, no passive-voice walls of text).

### Why not `agent-ste` or `ste-guard`

Both were installed and removed twice in this repo's history (see issue #12). `ste-guard` is a Claude Code plugin whose write guard never fires in pi at all. `agent-ste` has a real pi adapter but is a static linter with always-on hard blocks, which is what made it noisy enough to remove. Neither trigger only on a *degrading* trend, which is the core requirement here.

### How it decides when to act

It is lazy by construction, not just by a low duty cycle:

- `scorer.ts` scores prose deterministically (no LLM calls) against a small ASD-STE100-lite rule set: not-approved-word swaps, sentence length, passive voice, hedging/filler phrases, marketing puffery, and unstructured prose walls. The score is normalized per 100 words.
- `baseline.ts` tracks a rolling per-session baseline (EWMA) rather than a fixed bar. After a short warmup, it only flags a sample as *degrading* when the score jumps well past that session's own recent baseline, and only intervenes once that holds for two consecutive samples. A session that has always run wordy is left alone; a session that starts clean and drifts is not. Degrading samples never pull the baseline up with them, so slow drift stays visible instead of becoming the new normal.
- On a confirmed degrade, `scorer.ts#autofix()` applies only meaning-preserving mechanical fixes locally (dictionary word swap, or deleting a filler opener when it is the *entire* first sentence — never a partial prefix, which would leave a dangling fragment). Anything that needs judgment (sentence length, passive voice, hedging) is reported, never rewritten.
- If the mechanical fixes are not enough, a single short (~40 word) reminder is queued and injected once via `before_agent_start` for the next turn only, then cleared. There is no per-turn rule-card injection.

### Does it improve over time?

The per-session baseline in `baseline.ts` alone does **not**: it resets to empty on every `session_start`, and the dictionary in `dictionary.ts` is a hardcoded, frozen list. Left as originally shipped, neither the writing-quality judgment nor the approved-word list would ever get better on their own. Two additions close that gap, both cross-session and both file-backed under `~/.pi/agent/data/ste-lite/`:

- **`history.ts`** persists a running, count-weighted mean score per channel (`history.json`) across every session that ever ran (capped at a rolling window of 500 samples so it stays responsive rather than nearly immovable after months of use). Only samples the baseline did **not** flag as degrading are folded in — this is the load-bearing invariant that makes the mechanism actually improve calibration instead of normalizing bad behavior: if a degrading sample were folded in, a session (or a slow drift across many sessions) that writes worse and worse would drag the historical mean up with it, and a future session just as bad would stop looking degrading relative to that inflated baseline. A new session's baseline is seeded from that clean-only history (`seedBaselineFromHistory`), so a returning session needs far fewer real samples before it can tell degrading from normal-for-you, instead of re-learning from a cold start every time. `/ste-lite history` shows the current running mean and clean-sample count per channel.
- **`candidates.ts`** tallies recurring `style/hedge`, `style/puffery`, and `style/opener` findings across sessions (`candidates.json`), capped at 200 entries. These are the only rules with stable, repeatable excerpts; `length/sentence`, `verb/passive`, and `structure/prose-wall` excerpts are content-derived and would just be one-off noise. `/ste-lite candidates [n]` surfaces the most frequent recurring phrases. `/ste-lite promote <word> <replacement>` lets a human turn one of those into a hard, auto-fixed dictionary entry, stored in a small user-editable overlay (`custom-dictionary.json`) merged with the built-in list at runtime. The approved-word list only grows when a person decides it should — consistent with every rule in `scorer.ts` never rewriting a judgment call on its own.

Both persist incrementally (every 15 scored samples) and on `session_shutdown`, so a crash loses at most a few samples of learning. Writes to every JSON file under `~/.pi/agent/data/ste-lite/` are write-then-rename (never a truncate-in-place), so a crash mid-write cannot leave a half-written, corrupt file behind.

### Known limitation: cross-process races

All of `config.json`, `history.json`, `candidates.json`, and `custom-dictionary.json` are read-modify-write with no lock across processes. Two pi processes flushing at the same moment (plausible: this extension is installed globally, so every concurrently running pi session on the machine shares the same files) can race, and the second write wins — the first process's contribution for that flush is silently lost, not corrupted. This is a real but bounded risk: at most one flush interval (15 observations, or one session) of learning per collision, never data corruption, and the next flush from either process recovers normal accumulation. `model-scores/cache.ts` in this same repo already has the fix pattern (`withCacheLock`, a directory-based mutex with a timeout) that ste-lite does not yet use; see Next Steps below.

### Modes and safety

- `~/.pi/agent/data/ste-lite/config.json` holds `enabled`, `mode` (`observe` | `nudge` | `strict`), and `scope` (`replies` / `edits`). It ships defaulting to `mode: "observe"`: logging only, zero visible behavior change, until thresholds are calibrated against real sessions (see rollout plan in issue #12).
- `nudge` applies local autofixes and notifies; it never blocks a tool call.
- `strict` additionally blocks a `write`/`edit` tool call, but only when every finding in the new prose is the single safest deterministic category (`dictionary/not-approved-word` with an unambiguous replacement) — never on a judgment-call rule.
- `STE_LITE_DISABLE=1` fully disables all hooks regardless of config, given the install/remove churn on the two prior tools. `/ste-lite [status|on|off|mode <observe|nudge|strict>|reset]` controls it live, no `/reload` required.
- Every handler is wrapped in try/catch and returns a no-op on any internal error, so a scorer bug can never break the hook chain shared with `pi-hermes-memory` or `context-mode`. Context injection is additive-only (one `before_agent_start` system-prompt append, cleared after use).
- Observations (score, finding count, degrade/intervene decisions) are logged to `~/.pi/agent/data/ste-lite/observations.log`, capped at 512KB, to support threshold calibration before flipping the default mode.

### Verification

```sh
bunx vitest run pi/.pi/agent/extensions/ste-lite-tests/
pi --no-session --no-extensions -e pi/.pi/agent/extensions/ste-lite/index.ts -p 'Reply with exactly OK.'
```

The unit tests cover the scorer (word/sentence rules, prose-span extraction for markdown vs. source-file comments, the autofix safety guards, custom-dictionary overrides), the baseline (warmup, degrade-streak detection, no upward drift on degrading samples, one-shot recovery), the cross-session history merge (count-weighted averaging, the effective-weight cap, warmup seeding), and the candidate tracker (tracked-vs-ignored rules, cross-call accumulation, the entry cap). The print-mode check confirms the extension loads under pi's real extension loader and the `message_end` hook fires without error.

All of the above was verified live, not just via vitest: two separate `pi -p` processes in sequence showed `history.json`'s count-weighted mean and `candidates.json`'s counts both persist and accumulate correctly across process boundaries; a forced-degrade run confirmed a degrading sample does **not** get folded into history (`count` stayed `0`) while a clean sample does (`count` became `1`) — the exact invariant the whole "improves rather than normalizes" claim depends on; and `/ste-lite promote robust reliable` followed by a forced-degrade run showed the promoted word actually get auto-fixed (`robust` -> `reliable`) in a live reply, confirming the full recurring-finding-to-hard-dictionary loop end to end.

### Next steps

1. **Cross-process locking.** Port `model-scores/cache.ts`'s `withCacheLock` (directory-based mutex, timeout-bounded) to ste-lite's `writeJson`/`readJson` so concurrent pi sessions on the same machine stop racing on `history.json`/`candidates.json`/`custom-dictionary.json`. Not urgent (bounded data loss, never corruption), but cheap to fix given the pattern already exists in this repo.
2. **Let it run in `observe` mode** for real, across enough sessions that `history.json`'s `count` climbs meaningfully (dozens, not a handful) before trusting the seeded warmup. Check `/ste-lite history` and `/ste-lite candidates` periodically.
3. **Calibrate thresholds** (`DEGRADE_RATIO`, `DEGRADE_ABS`, `STREAK_THRESHOLD`, `DEFAULT_WARMUP_COUNT` in `baseline.ts`; `SENTENCE_SOFT_WORDS`/`SENTENCE_HARD_WORDS`/`PROSE_WALL_MIN_WORDS` in `scorer.ts`) against real `observations.log` data, then flip to `nudge` via `/ste-lite mode nudge`.
4. **Review `/ste-lite candidates` periodically** and promote genuinely recurring offenders with `/ste-lite promote`. This is the only way the approved-word list grows — it will not happen on its own, by design.
5. **Decide on `strict` mode** only after `nudge` has run cleanly for a while; it can block a `write`/`edit` on unambiguous not-approved-word findings, including anything promoted via step 4.

## Bedrock GPT 5.6 reasoning

`bedrock-openai-reasoning.ts` is a compatibility extension for OpenAI GPT 5.6 models invoked through Amazon Bedrock's Converse API.

### Why it exists

Pi 0.84.2 correctly exposes reasoning capable GPT 5.6 models and advertises `xhigh` in the model catalog, but its Bedrock adapter only adds reasoning request fields for Claude models. Without this extension, selecting `high`, `xhigh`, or another thinking level changes pi's local state but does not send GPT 5.6's effort parameter to Bedrock.

### How it works

Before each provider request, the extension checks the active model ID for `openai.gpt-5.6-`. For a matching model, it reads pi's effective thinking level and returns the request payload with this Bedrock Converse field merged in:

```json
{
  "additionalModelRequestFields": {
    "reasoning": {
      "effort": "xhigh"
    }
  }
}
```

The mapping is:

| Pi level | Bedrock effort |
| --- | --- |
| `off` | `none` |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

It only changes GPT 5.6 Bedrock payloads. Other models and providers are left untouched. It also preserves any existing fields in `additionalModelRequestFields` and any other provider payload fields.

### After changing the thinking level

Use `/reload` after installing or editing the extension. Then select the desired thinking level and send a prompt. The current effective level is available to shell commands as `PI_REASONING_LEVEL`.

### Verification

To verify the extension is present and pi can load it:

```sh
pi --list-models | grep 'gpt-5.6-luna'
```

For a payload level check, temporarily add a `console.log(JSON.stringify(event.payload))` line inside the `before_provider_request` handler, run one small prompt, and remove the logging afterward. Do not leave request payload logging enabled because prompts and tool definitions may contain sensitive data.

## What to do after updating pi

The extension is stored in this dotfiles repository, not inside pi's installed package. A normal pi update should not delete it.

After updating pi:

1. Restart pi or run `/reload`.
2. Run `pi --list-models | grep 'gpt-5.6-luna'`.
3. Check that pi still loads `pi/.pi/agent/extensions/bedrock-openai-reasoning.ts` through `~/.pi/agent/extensions/bedrock-openai-reasoning.ts`.
4. Test one small GPT 5.6 request with `xhigh` selected.
5. If a newer pi release natively supports GPT 5.6 Bedrock effort, remove this workaround only after confirming the native payload behavior. Otherwise, keep it.

Do not edit the installed file under `/opt/homebrew/lib/node_modules`. The source of truth is this file in dotfiles. The live extension path is a symlink created by GNU Stow or the equivalent dotfiles setup.

To check whether the workaround is still needed, inspect the installed adapter for GPT 5.6 handling:

```sh
grep -n -A80 'function buildAdditionalModelRequestFields' \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js
```

If the adapter natively emits `additionalModelRequestFields.reasoning.effort` for OpenAI GPT 5.6 models, disable or remove this extension to avoid duplicate ownership of the behavior. The extension merges the field safely, but native support is preferable.
