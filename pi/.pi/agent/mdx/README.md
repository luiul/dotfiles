# /mdx

Render a pi answer into a rich, scannable, interactive HTML review surface and open it in the browser. Inspired by Builder.io's visual-plan skill, adapted to run fully local with no server or MCP.

## Parts

| File | Role |
| --- | --- |
| `extensions/mdx.ts` | Registers the `/mdx` command. Picks the source answer, decides the mode, writes Markdown to `~/scratch/`, and renders. |
| `mdx/render.py` | `uv run` script. Embeds a Markdown file (base64, UTF-8 safe) into `template.html` and opens the result. Pure stdlib. |
| `mdx/template.html` | The viewer shell: Markdown via `marked`, diagrams via `mermaid`, sticky table of contents, theme toggle, and a feedback panel. |

The extension lives in `extensions/` (auto-discovered) and the renderer in `mdx/`, both stowed into `~/.pi/agent/`.

## Usage

```
/mdx              Enrich the latest answer, then render (default)
/mdx -s           Simple: render the latest answer verbatim
/mdx -t           Pick which answer in the session to render
/mdx -s -t        Pick an answer, render it verbatim
```

Flags: `-s`/`--simple`, `-t`/`--tree`. Output files land in `~/scratch/mdx-<slug>-<YYYYMMDD-HHMM>.{md,html}`. The extension names the file (the slug is derived from the answer's title) in both modes.

## Modes

- **Enrich (default)**: the extension writes the target path, then hands the source answer to the model with authoring instructions (TL;DR, decisions checklist, headings, tables, Mermaid diagrams, callouts). The model writes the Markdown to that path and runs the renderer. The instruction is sent as a hidden message (`display: false`) so it does not clutter the transcript.
- **Simple (`-s`)**: the extension writes the answer verbatim and runs the renderer directly. Deterministic, no model call.

## The closed loop

The viewer's feedback panel turns live checkboxes and a notes box into a Markdown block you copy back into pi. That is how decisions made in the rendered doc come back into the conversation.

## Notes

- The viewer loads `marked` and `mermaid` from vendored copies in `mdx/vendor/` (referenced as local `file://` URIs), so rendered docs work fully offline. No CDN or network access needed.
- `render.py` is standalone: `uv run render.py <file.md> [--title "..."] [--no-open]`.

## Updating the vendored libraries

```sh
cd ~/.pi/agent/mdx/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/marked/marked.min.js -o marked.min.js
curl -fsSL https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js -o mermaid.min.js
```

Currently pinned: `marked` v15, `mermaid` v11.
