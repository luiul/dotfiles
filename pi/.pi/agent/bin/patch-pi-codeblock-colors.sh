#!/usr/bin/env bash
#
# patch-pi-codeblock-colors.sh
#
# Two rendering fixes for pi's Markdown code blocks (pi 0.84.3, upstream
# @earendil-works/pi-coding-agent):
#
# FIX 1 — unstyled code-block content, most visible with ```text /
#   ```plaintext fences, which GPT-5.6 emits habitually.
#   dist/utils/syntax-highlight.js lazily registers ALL highlight.js
#   languages shortly after startup (loadAllHighlightLanguages). Before that
#   load, supportsLanguage("text") is false and pi's Markdown renderer falls
#   back to coloring the whole block with the mdCodeBlock theme color. After
#   the load, "text" resolves to hljs' "plaintext" grammar, which has NO
#   highlighting rules, so every line comes back without a single <span>.
#   pi's cli-highlight theme (buildCliHighlightTheme in theme.js) defines
#   formatters for hljs scopes (keyword, string, ...) but NO "default"
#   formatter, so unscoped text is emitted completely unstyled — the code
#   block content renders in the terminal's default color and looks like
#   raw, unformatted text. The same gap leaves unscoped segments (braces,
#   spaces, plain words) of EVERY language uncolored; plaintext is just the
#   case where 100% of the content is unscoped.
#   Fix: add `default: (s) => t.fg("mdCodeBlock", s)` so any text not
#   matched by a syntax scope still gets the code-block color.
#
# FIX 2 — hide the literal ``` fence lines.
#   pi's Markdown component draws the opening/closing fences as visible
#   "border" lines via the theme's codeBlockBorder function. There is no
#   setting to turn them off (settings only cover codeBlockIndent and
#   mermaid). Fix: make codeBlockBorder return an empty string, so fences
#   render as blank separator lines and the block shows as pure styled
#   content. codeBlockBorder is used ONLY for these two lines (verified in
#   pi-tui's markdown.js), so nothing else is affected.
#
# Both fixes are applied to:
#   1. dist/bundle/chunks/*.js   (what the `pi` binary actually runs)
#   2. dist/modes/interactive/theme/theme.js  (module graph / SDK)
#
# This patches the installed npm package, which is REPLACED on every pi
# upgrade — re-run this script after upgrading pi. It is idempotent: if the
# patches (or equivalent upstream fixes) are already present, it does
# nothing. If an anchor has changed upstream and a patch cannot be applied,
# the script warns and exits non-zero instead of corrupting the install.
#
# Usage:
#   patch-pi-codeblock-colors.sh           apply if needed
#   patch-pi-codeblock-colors.sh --check   report status only, exit 1 if unpatched

set -euo pipefail

PI_DIST="$(npm root -g)/@earendil-works/pi-coding-agent/dist"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -d "$PI_DIST" ]; then
  echo "error: pi install not found at $PI_DIST" >&2
  exit 1
fi

status=0

# apply_perl_patch <file> <sed-expr-with-literal-anchors> <patched-marker> <label>
# The sed expr must be safe for perl -pi -e with \Q...\E quoting of literals.
apply_patch() {
  local file="$1" perl_expr="$2" marker="$3" label="$4"
  if [ ! -f "$file" ]; then
    echo "warn: $file not found" >&2
    status=1
    return
  fi
  if grep -qF "$marker" "$file"; then
    echo "ok: $label already patched"
    return
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "missing: $label not patched ($file)"
    status=1
    return
  fi
  if ! perl -pi -e "$perl_expr" "$file"; then
    echo "warn: failed to patch $file" >&2
    status=1
    return
  fi
  if grep -qF "$marker" "$file"; then
    echo "patched: $label ($file)"
  else
    echo "warn: anchor not found for $label in $file; upstream may have changed or fixed this" >&2
    status=1
  fi
}

# --- locate the bundle chunk containing the theme code --------------------
bundle_file=""
for f in "$PI_DIST"/bundle/chunks/*.js; do
  if grep -q 'buildCliHighlightTheme' "$f" 2>/dev/null; then
    bundle_file="$f"
    break
  fi
done
module_file="$PI_DIST/modes/interactive/theme/theme.js"

if [ -z "$bundle_file" ]; then
  echo "warn: buildCliHighlightTheme not found in any bundle chunk; pi's internals changed?" >&2
  status=1
else
  # FIX 1a: default formatter (bundle)
  apply_patch "$bundle_file" \
    's/buildCliHighlightTheme\(t\)\{return\{keyword:s=>t\.fg\("syntaxKeyword",s\),/buildCliHighlightTheme(t){return{default:s=>t.fg("mdCodeBlock",s),keyword:s=>t.fg("syntaxKeyword",s),/' \
    'default:s=>t.fg("mdCodeBlock",s)' \
    "bundle default code color"

  # FIX 2a: hide fence borders (bundle, both theme variants)
  apply_patch "$bundle_file" \
    's/codeBlockBorder:text=>theme\.fg\("mdCodeBlockBorder",text\)/codeBlockBorder:()=>""/g; s/codeBlockBorder:text=>source_default\.dim\(text\)/codeBlockBorder:()=>""/g' \
    'codeBlockBorder:()=>""' \
    "bundle hidden code fences"
fi

# FIX 1b: default formatter (module graph)
apply_patch "$module_file" \
  's/        keyword: \(s\) => t\.fg\("syntaxKeyword", s\),/        default: (s) => t.fg("mdCodeBlock", s),\n        keyword: (s) => t.fg("syntaxKeyword", s),/' \
  'default: (s) => t.fg("mdCodeBlock", s),' \
  "module default code color"

# FIX 2b: hide fence borders (module graph)
apply_patch "$module_file" \
  's/        codeBlockBorder: \(text\) => theme\.fg\("mdCodeBlockBorder", text\),/        codeBlockBorder: () => "",/' \
  'codeBlockBorder: () => "",' \
  "module hidden code fences"

exit "$status"
