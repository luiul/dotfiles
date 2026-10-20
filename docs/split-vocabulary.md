# Split Extension Vocabulary

Canonical terms for the pi split extension (`pi/.pi/agent/extensions/split/`). Use these verbatim in issues, commits, reviews, and the extension README. Panel titles today are `Thinking`, `Tool Usage`, and `File Changes`; the header consistency issue (#48) shortens `Tool Usage` to `Tools`, and this vocabulary already uses the short names.

This is the split domain sub-glossary of the repo glossary (`docs/glossary.md`), which keeps the cross repo terms. Sources: the split source files and `pi/.pi/agent/extensions/README.md`, Split view section.

## Layout structure

- **split view**: the fullscreen two-column composition: the left column plus the dock, joined by the divider. Fullscreen only; in regular TUI mode the extension stays dormant.
- **left column**: the transcript surface. Its width is the left share, 60% by default, clamped to a 20 to 80 band. Two modes: full transcript and response-only.
- **dock**: the right column, the stack of panels. The top of the dock is the natural glance position. Older docs also say "right column"; "dock" is canonical.
- **divider**: the single dim `│` column between the left column and the dock. Accent colored while dragging; a drag clamps the left share to the 20 to 80 band. The keyboard path is `/split-width <pct>`.
- **panel**: one section of the dock: a single 1-row header plus a body. Each panel gets a row share of the dock rows (defaults: Thinking 30, Tools 25, File Changes 45), set by the `/split-*-height` commands.
- **header**: the 1-row panel title bar. It doubles as the separator to the next panel (minimal frame policy: no box borders). Shows the title, an optional count suffix, and the streaming indicator.
- **streaming indicator**: the dim ` …` in a panel header while that panel is live.

## Left column

- **full transcript mode**: pi's own base root rendered verbatim in the left column.
- **response-only mode**: the left column shows the response doc instead. Toggle: `/split-trim-response` (the legacy name "trim response" survives in the command).
- **response doc**: the singleton Container of answer blocks behind response-only mode. Its ScrollView is a retained singleton: the scroll offset survives rebuilds, mode toggles, and branch switches.
- **answer block**: one block in the response doc: a user message, an assistant message, or a bash block. Thinking and tool calls stay out of the doc; the dock owns them.
- **bash block**: a `!` or `!!` command in the response doc, with its output, exit status, and exit code (the no information loss work of 2026-10-24).
- **sticky bar**: the pinned user prompt bar (`split-sticky.ts`). While the owning user prompt is scrolled above the view, it pins at the top of the left column.

## Panels

- **Thinking panel**: renders thinking blocks. Coalesced 100 ms flushes, 400 line bound.
- **thinking block**: one reasoning block. Boundaries between blocks carry a dim separator line.
- **Tools panel**: renders tool entries. Compact mode is the default; full detail via `/split-tools-view`. 60 entry bound.
- **tool entry**: one call row: the tool name, an args preview, a status mark, and in full mode up to two output lines plus a `+N more` row.
- **status mark**: the per entry glyph in the Tools panel: `✓` succeeded, `✗` error, `●` active.
- **File Changes panel**: renders the shared tracker state (`filechanges-tracker.ts`). Rows and semantic colors always match the above-editor widget, because both read the same tracker. Renders newest first.
- **kind word**: the colored change type word in a File Changes row, for example `modified` or `untracked`, padded to 9 columns. (One letter "kind codes" were proposed and rejected.)
- **row share**: a panel's percentage of the dock rows, renormalized to 100 across visible panels.

## Display order

- **newest at top**: every panel renders its newest item as the topmost row, with the viewport anchored there (the File Changes pattern). Decided 2026-10-18; the panels that still render oldest first with follow mode "end" are the open #43 work.
- **follow mode**: the ScrollView anchoring policy. `end` follows the newest content at the bottom; `none` keeps the viewport where it is. Newest at top requires `none`.

## Guardrail terms (every issue must respect these)

- **render cache**: the composition cache keyed by theme fingerprint and terminal columns. When neither changed, no recompose. Preserve in every change.
- **coalesced flush**: the 100 ms timer that batches panel body updates. Preserve in every change.
- **bounds**: the `MAX_*` buffer caps: `MAX_LINES` (400, thinking), `MAX_TOOLS` (60), `MAX_TOOL_TEXT_CHARS` (32 KiB newest suffix per tool text), `MAX_BODY_ROWS` (96, the panel body row window). Preserve in every change.
- **layer**: the layout ownership unit of the split composition, see the repo glossary.
