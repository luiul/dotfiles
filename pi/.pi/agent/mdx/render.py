#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Render a Markdown file into a self-contained interactive HTML review surface.

Usage:
  render.py <markdown-file> [--title "Title"] [--no-open]

Embeds the Markdown (base64, UTF-8 safe) into template.html next to this script,
writes <markdown-file>.html, and opens it in the default browser. The viewer
renders Markdown + Mermaid diagrams and provides a feedback panel whose output
can be copied back into pi.
"""
import base64
import datetime as dt
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
VENDOR = HERE / "vendor"


def main() -> int:
    args = [a for a in sys.argv[1:]]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    do_open = "--no-open" not in args
    args = [a for a in args if a != "--no-open"]

    title = None
    if "--title" in args:
        i = args.index("--title")
        if i + 1 >= len(args):
            print("error: --title requires a value", file=sys.stderr)
            return 1
        title = args[i + 1]
        del args[i : i + 2]

    if not args:
        print("error: no markdown file given", file=sys.stderr)
        return 1

    md_path = pathlib.Path(args[0]).expanduser().resolve()
    if not md_path.is_file():
        print(f"error: not a file: {md_path}", file=sys.stderr)
        return 1

    md = md_path.read_text(encoding="utf-8")
    if title is None:
        # First markdown H1, else filename
        for line in md.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        else:
            title = md_path.stem

    b64 = base64.b64encode(md.encode("utf-8")).decode("ascii")
    generated = dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    html = TEMPLATE.read_text(encoding="utf-8")
    html = (
        html.replace("{{CONTENT_B64}}", b64)
        .replace("{{TITLE_JSON}}", json.dumps(title))
        .replace("{{GENERATED_JSON}}", json.dumps(generated))
        .replace("{{TITLE}}", title.replace("<", "&lt;"))
        .replace("{{MARKED_SRC}}", (VENDOR / "marked.min.js").as_uri())
        .replace("{{MERMAID_SRC}}", (VENDOR / "mermaid.min.js").as_uri())
    )

    out = md_path.with_suffix(".html")
    out.write_text(html, encoding="utf-8")
    print(out)

    if do_open:
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        try:
            subprocess.run([opener, str(out)], check=False)
        except FileNotFoundError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
