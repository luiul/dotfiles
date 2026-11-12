# Scoped model guide

`/model-guide` compares the current session's scoped models without selecting one. Native `/model`, Tab, model cycling and default selection stay unchanged. The seven global favorites are Terra high (Daily), Kimi K3.1 Pro high (Code), Sol medium (Think), GLM high (Budget), Luna low (Quick), Argon high (Vision) and GLM Flash off (Helper). Terra remains the default.

## Use

Open `/model-guide`, or `/model-guide think` to start with a search. Search matches provider, model, role and purpose. Arrow keys and PageUp/PageDown move through the list. Tab changes focus between the list and the details. Arrow keys and PageUp/PageDown then scroll the details. Escape or Enter closes the guide. Closing never selects a model or writes settings.

The list respects the actual session scope, including project settings and command-line `--models` overrides. It does not keep a second favorites list. An unscoped session shows a message rather than the full catalog. Unknown scoped models remain usable in the guide, with unknown evidence and no curated purpose.

## Data ownership

- Session scope supplies membership and order.
- Resolved models supply canonical identity, native role and purpose, catalog rates and context limits. Router display names remain owned by [Grove](https://github.com/luiul/grove) `overlay.json`.
- Effective settings supply per-model thinking pins. An inline scope pattern takes precedence over a model pin. Only the active model shows actual current thinking. Unpinned models are labelled unpinned; Pi applies its own default/current fallback and capability clamping when selected.
- `pi/.pi/agent/model-guide.json` is the sole source of guide benchmark evidence. It stores score, benchmark version, published effort, source URL, review date and qualifiers. It does not store membership, roles, prices or context limits. Grove's older intelligence data remains separate and is not used by the guide.

Matching effort does not prove matching provider behavior. Kimi's published effort is unverified. GLM's available max score is not a high score. Flash's reasoning-version score is not an off score. Missing or mismatched evidence is labelled unknown. The review date is shown without an automatic expiry rule. Future dates are flagged. Invalid records are ignored, while valid records and catalog fields remain available.

Prices are catalog values per million tokens, not costs per successful task or verified invoices. Zero is displayed as a catalog value, not free usage. Flat prices can omit long-context tiers and other provider charges. Argon's intelligence score is not a vision benchmark. No overall ranking is calculated.

## Runtime

The extension registers one command. It adds no tool, prompt content, model calls, native patch, selection hook, network refresh, timer, watcher or worker. The command loads its view and reads evidence only when opened. Search and rendering use the resulting local snapshot. The guide writes nothing. The footer remains compact; its role matcher recognizes Code so Kimi retains its canonical identity.

Semantic theme colors distinguish roles and warnings. Scores stay neutral. Labels remain readable without color. Details wrap, and narrow terminals use a small list with scrollable details. Tiny surfaces show an enlarge-terminal hint with working close keys.

## Verification

From the dotfiles source worktree:

```sh
bun scripts/test-model-guide.ts
node scripts/test-pi-model-roles.mjs
node scripts/test-model-guide-live.mjs
```

The live test needs `rex` on PATH and the maintained private Rex driver. If the CLI is not on PATH, use a private test-only symlink to the installed Rex app helper; do not install or replace the shared command. It starts separate servers, not desktop sessions. Provider fixtures are local and do not call vendors. It checks command prompt parity, guide behavior, native picker behavior, Kimi effort and footer identity, CLI scope and themes. Cleanup failures fail the test. Unit checks include malformed evidence, unknown models, effort precedence and terminal bounds.

## Measured candidate evidence

On 12 November 2026 with Pi 1.5.1, the final seven-pair rotated process fixture reported a median of 514.2 ms without the guide and 525.3 ms with it. Median absolute deviations were 0.9 ms and 7.2 ms. This interval includes startup, one local fixture completion and shutdown; it is not isolated startup latency. Earlier runs varied, so these samples do not establish a speed improvement or a stable regression.

The first guide wait-to-frame sample was 161.1 ms. Seven repeated command-to-frame samples had a median of 221.7 ms, including terminal input and capture. These boundaries differ and are not a cold/warm speed comparison. Both baseline and guide processes showed no measurable CPU-time increase over four idle seconds at `ps` resolution of 0.01 seconds. One RSS sample was 165,392 KiB without the guide and 158,832 KiB with it; memory varied substantially across runs and is not a measured saving.

Fourteen real Pi fixture requests had identical prompt strings and tool sets with the extension absent or loaded. Opening, searching, scrolling and closing the guide made no provider requests. Tests covered native scope switching, Kimi high selection, footer identity, CLI and project scopes, dark and light themes, 40-column and 12-column terminal layouts, and private fixture shutdown. This is isolated real Pi verification, not deployment to the user's existing interactive sessions.

Implementation, publication and live deployment are separate. The source worktree does not automatically replace the dirty live checkout. Settings use the live file vs snapshot pattern; merge only the reviewed scope and thinking changes into the live file, then refresh its snapshot without losing other package or runtime changes.
