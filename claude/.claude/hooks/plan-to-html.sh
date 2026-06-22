#!/usr/bin/env bash
# PreToolUse hook for ExitPlanMode: render the just-written plan to a temporary
# HTML file, open it in the default browser, and print a clickable file:// link
# as a fallback. Non-blocking: always exits 0 so the plan approval proceeds.
#
# The ExitPlanMode tool input does NOT carry the plan text, so we locate the
# plan file ourselves: the newest-modified *.md in ~/.claude/plans/.

set -uo pipefail

# Consume stdin so the hook pipe closes cleanly (payload fields are not needed).
cat >/dev/null 2>&1 || true

PLANS_DIR="${HOME}/.claude/plans"

emit() {
  # Print a user-visible terminal message (not fed to the model) and exit 0.
  printf '{"systemMessage": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 0
}

[ -d "$PLANS_DIR" ] || emit "Plan preview skipped: ${PLANS_DIR} not found."

# Newest-modified markdown plan (the one just written before ExitPlanMode).
PLAN_FILE="$(find "$PLANS_DIR" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null \
  | xargs -0 stat -f '%m %N' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)"

[ -n "${PLAN_FILE:-}" ] && [ -f "$PLAN_FILE" ] || emit "Plan preview skipped: no plan file found in ${PLANS_DIR}."

# Temp HTML target (BSD mktemp has no --suffix).
TMP="$(mktemp -t claude-plan)" || emit "Plan preview skipped: mktemp failed."
HTML="${TMP}.html"
mv "$TMP" "$HTML" 2>/dev/null || HTML="$TMP"

# Render markdown -> styled, light/dark-aware HTML via uv (no global install).
PLAN_TITLE="$(basename "$PLAN_FILE" .md)"
if ! PLAN_PATH="$PLAN_FILE" HTML_OUT="$HTML" PLAN_TITLE="$PLAN_TITLE" \
  uv run --quiet --with markdown python3 - <<'PY' 2>/dev/null
import html
import os

import markdown

src = os.environ["PLAN_PATH"]
out = os.environ["HTML_OUT"]
title = os.environ.get("PLAN_TITLE", "Plan")

with open(src, encoding="utf-8") as fh:
    text = fh.read()

body = markdown.markdown(
    text,
    extensions=["fenced_code", "tables", "toc", "sane_lists"],
)

doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
  :root {{
    --fg:#1f2328; --muted:#656d76; --bg:#ffffff; --accent:#0969da;
    --code-bg:#f6f8fa; --border:#d0d7de;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --fg:#e6edf3; --muted:#9198a1; --bg:#0d1117; --accent:#4493f8;
      --code-bg:#161b22; --border:#30363d; }}
  }}
  * {{ box-sizing:border-box; }}
  body {{
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color:var(--fg); background:var(--bg); max-width:860px;
    margin:0 auto; padding:2.5rem 1.5rem 5rem;
  }}
  h1 {{ font-size:2rem; border-bottom:1px solid var(--border); padding-bottom:.4em; margin-top:0; }}
  h2 {{ font-size:1.4rem; border-bottom:1px solid var(--border); padding-bottom:.3em; margin-top:2.2em; }}
  h3 {{ font-size:1.1rem; margin-top:1.8em; }}
  h4 {{ font-size:1rem; color:var(--muted); margin-bottom:.4em; }}
  code {{ background:var(--code-bg); padding:.15em .4em; border-radius:6px; font-size:.88em;
    font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; }}
  pre {{ background:var(--code-bg); border:1px solid var(--border); border-radius:8px;
    padding:1em; overflow-x:auto; }}
  pre code {{ background:none; padding:0; }}
  a {{ color:var(--accent); }}
  ul, ol {{ padding-left:1.4em; }}
  li {{ margin:.25em 0; }}
  table {{ border-collapse:collapse; width:100%; margin:1em 0; }}
  th, td {{ border:1px solid var(--border); padding:.5em .75em; text-align:left; }}
  th {{ background:var(--code-bg); }}
  blockquote {{ border-left:3px solid var(--border); margin:0; padding:.2em 1em; color:var(--muted); }}
  hr {{ border:none; border-top:1px solid var(--border); margin:2.5em 0; }}
  .src {{ color:var(--muted); font-size:.85rem; margin-top:3em; }}
</style>
</head>
<body>
{body}
<hr>
<p class="src">Plan preview &middot; source: <code>{html.escape(src)}</code></p>
</body>
</html>
"""

with open(out, "w", encoding="utf-8") as fh:
    fh.write(doc)
PY
then
  emit "Plan preview skipped: failed to render ${PLAN_FILE}."
fi

# Open in default browser (macOS); ignore failure (headless/no GUI).
open "$HTML" >/dev/null 2>&1 || true

emit "Plan preview: file://${HTML}"
