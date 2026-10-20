# Split Extension Vocabulary

Canonical terms for the pi split extension (`pi/.pi/agent/extensions/split/`). Use these verbatim in issues, commits, reviews, and the extension README. Panel titles today are `Thinking`, `Tool Usage`, and `File Changes`; the header consistency issue (#48) shortens `Tool Usage` to `Tools`, and this vocabulary already uses the short names.

This is the split domain sub-glossary of the repo glossary (`docs/glossary.md`), which keeps the cross repo terms. Sources: the split source files and `pi/.pi/agent/extensions/README.md`, Split view section.

Pi's own vocabulary is the source of truth: where a concept exists in pi, the split vocabulary uses pi's term verbatim, and where the extension needs a new concept, the term is defined here first. The alignment section at the end lists the pi terms the extension builds on.

## Layout structure

- **split view**: the fullscreen two-column composition: the left column plus the right column, joined by the divider. Fullscreen only; in regular mode the extension stays dormant.
- **left column**: the surface that shows the pi transcript or the response doc. Its width is the left share, 60% by default, clamped to a 20 to 80 band. Two modes: full transcript and response-only.
- **right column**: the stack of panels. The top of the right column is the natural glance position. (Earlier notes called this the "dock"; renamed because in pi the dock is the input dock at the bottom.)
- **divider**: the single-column gap between the left column and the right column. Blank at rest; one accent ASCII `|` column while dragging (chosen over `│` because a full-height box drawing column renders with artifacts in the VS Code terminal). A drag clamps the left share to the 20 to 80 band. The keyboard path is `/split-width <pct>`.
- **panel**: one section of the right column: a single 1-row header plus a body. Each panel gets a row share of the right column rows (defaults: Thinking 30, Tools 25, File Changes 45), set by the `/split-*-height` commands.
- **header**: the 1-row panel title bar. It doubles as the separator to the next panel (minimal frame policy: no box borders). Shows the title, an optional count suffix, and the streaming indicator.
- **streaming indicator**: the dim ` …` in a panel header while that panel is live.
- **transient scrollbar**: the scrollbar a panel shows only while the user scrolls: a border-styled track with an accent thumb, overlaying the body's last column, hidden at rest (introduced by #46). This is pi-tui's `scrollbar: "auto"` mode.
- **block divider**: the separator inserted AFTER response blocks in the response doc (between a finished assistant answer and whatever follows, a prompt or another answer continuation): one blank row above (the divider's own), one full-width `borderMuted` `─` stroke, and the next block's leading blank below — a compact symmetric gap. Never between a prompt and its answer, and never around bash blocks (they self-frame and carry their own background). In the Thinking panel, where lines carry no component padding, the divider provides both blank rows itself. (Design 2026-10-20, third iteration, measured in a real tmux run; supersedes the #44 and #47 drafts.)

## Left column

- **full transcript mode**: pi's own base root rendered verbatim in the left column, that is, the pi transcript and the input dock, unmodified.
- **response-only mode**: the left column shows the response doc instead. Toggle: `/split-trim-response` (the legacy name "trim response" survives in the command).
- **response doc**: the singleton Container of answer blocks behind response-only mode. Its ScrollView is a retained singleton: the scroll offset survives rebuilds, mode toggles, and branch switches.
- **answer block**: one block in the response doc: a user message, an assistant message, or a bash block (pi message roles: `user`, `assistant`, `bashExecution`). Thinking and tool calls stay out of the doc; the right column owns them.
- **response block**: an assistant answer block in the response doc, that is, a pi assistant message. The block type the block divider prefixes; user messages and bash blocks get no divider (user messages are visually distinct, bash blocks frame themselves).
- **bash block**: a `!` or `!!` command in the response doc, with its output, exit status, and exit code (the no information loss work of 2026-10-24). Backed by a pi `BashExecutionMessage` (role `bashExecution`) and rendered by pi's `BashExecutionComponent`.
- **sticky bar**: the pinned user prompt bar (`split-sticky.ts`). While the owning user prompt is scrolled above the view, it pins at the top of the left column.

## Panels

- **Thinking panel**: renders thinking blocks. Coalesced 100 ms flushes, 400 line bound.
- **thinking block**: one reasoning block, that is, one pi `ThinkingContent` block (content type `thinking`). Boundaries between blocks carry the block divider.
- **Tools panel**: renders tool entries. Compact mode is the default; full detail via `/split-tools-view`. 60 entry bound.
- **tool entry**: one call row, backed by one pi tool call (`ToolCall`, content type `toolCall`): the tool name, an args preview, a status mark, and in full mode up to two output lines plus a `+N more` row.
- **status mark**: the per entry glyph in the Tools panel: `✓` succeeded, `✗` error, `●` active.
- **File Changes panel**: renders the shared tracker state (`filechanges-tracker.ts`). Rows and semantic colors always match the filechanges widget, because both read the same tracker. Renders newest first.
- **kind word**: the colored change type word in a File Changes row, for example `modified` or `untracked`, padded to 9 columns. (One letter "kind codes" were proposed and rejected.)
- **row share**: a panel's percentage of the right column rows, renormalized to 100 across visible panels.

## Display order

- **newest at top**: every panel renders its newest item as the topmost row, with the viewport anchored there (the File Changes pattern). Decided 2026-10-18; the panels that still render oldest first with follow mode "end" are the open #43 work.
- **follow mode**: the pi-tui ScrollView `follow` option. `end` follows the newest content at the bottom; `none` keeps the viewport where it is. Newest at top requires `none`.

## Guardrail terms (every issue must respect these)

- **render cache**: the composition cache keyed by theme fingerprint and terminal columns. When neither changed, no recompose. Preserve in every change.
- **coalesced flush**: the 100 ms timer that batches panel body updates. Preserve in every change.
- **bounds**: the `MAX_*` buffer caps: `MAX_LINES` (400, thinking), `MAX_TOOLS` (60), `MAX_TOOL_TEXT_CHARS` (32 KiB newest suffix per tool text), `MAX_BODY_ROWS` (96, the panel body row window). Preserve in every change.
- **layer**: the layout ownership unit of the split composition, see the repo glossary.

## Pi vocabulary alignment (pi is the source of truth)

Pi terms the extension builds on, with their pi sources. Use these verbatim when writing about the extension.

- **transcript**: pi's scrolling conversation surface in fullscreen mode. The left column shows it verbatim in full transcript mode; pi's scroll keys live under `tui.altScreen.*` (https://github.com/earendil-works/pi, `docs/keybindings.md`).
- **dock / input dock**: pi's fixed bottom area holding the editor and the widgets (`chat-viewport.ts`: "Shared fullscreen transcript and fixed input-dock layout"). Never a name for the right column. The response doc reuses the input dock unchanged.
- **editor**: the input editor inside the input dock.
- **widget**: pi's `ctx.ui.setWidget()` persistent content near the editor (`docs/tui.md`). The filechanges widget is one; the File Changes panel suppresses it while active.
- **fullscreen mode / regular mode**: pi's two TUI modes; the split view exists only in fullscreen mode (`tuiMode: fullscreen`).
- **message roles**: `user`, `assistant`, `bashExecution` (`docs/message-types.md`).
- **content types**: `text`, `thinking` (`ThinkingContent`), `toolCall` (`ToolCall`) (`docs/message-types.md`).
- **session tree, branch, leaf, branch summary**: pi's session structure terms (`docs/session-format.md`); the extension's doc rebuild follows the current branch.
- **ScrollView options** (pi-tui): `follow` (`"end"`, `"none"`), `scrollbar` (`"always"`, `"auto"`), `overscroll` (`"contain"`, `"chain"`).
