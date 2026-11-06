#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown-it-py>=3.0", "pytest>=8"]
# ///
"""Tests for macos/.local/bin/md-to-rtf. They use the real macOS textutil and never touch the clipboard."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.dont_write_bytecode = True  # keep __pycache__ out of the stowed macos package

SCRIPT = Path(__file__).resolve().parent.parent / "macos" / ".local" / "bin" / "md-to-rtf"
_loader = importlib.machinery.SourceFileLoader("md_to_rtf", str(SCRIPT))
_spec = importlib.util.spec_from_loader("md_to_rtf", _loader)
md = importlib.util.module_from_spec(_spec)
_loader.exec_module(md)

SAMPLE = """**To:** Russell (r@example.com)
**Cc:** Tom, Safdar
**Subject:** A subject

Hi Russell,

A paragraph with **bold**, `code`, and a [link](https://example.com/page).

1. First
2. Second

- Bullet one
- Bullet two

Kind regards,
Luis
Data Engineering
"""


def to_rtf(text: str, **kw) -> str:
    return md.html_to_rtf(md.render_html(text, **kw)).decode("utf-8", errors="replace")


def as_text(rtf: str) -> str:
    out = subprocess.run(["textutil", "-convert", "txt", "-stdin", "-stdout"], input=rtf.encode(),
                         capture_output=True, check=True)
    return out.stdout.decode()


def test_default_font_is_helvetica_12pt():
    rtf = to_rtf(SAMPLE)
    assert "Helvetica" in rtf
    assert "Times" not in rtf
    sizes = set(re.findall(r"\\fs(\d+)", rtf))
    assert "24" in sizes  # RTF counts half points, so 24 is 12 pt
    assert "32" not in sizes  # the 16 pt trap: textutil turns 12pt CSS into 16 pt


def test_code_uses_mono_font_one_point_smaller():
    rtf = to_rtf(SAMPLE)
    assert "Menlo" in rtf
    assert "22" in set(re.findall(r"\\fs(\d+)", rtf))


def test_bold_and_link_survive():
    rtf = to_rtf(SAMPLE)
    assert re.search(r"\\b\b", rtf)
    assert 'HYPERLINK "https://example.com/page"' in rtf


def test_header_lines_and_signature_stay_on_separate_lines():
    """Regression: a single newline must stay a line break, or To/Cc/Subject merge into one line."""
    text = as_text(to_rtf(SAMPLE))
    first = text.splitlines()[0]
    assert first.startswith("To:") and "Cc:" not in first
    assert re.search(r"Kind regards,\s*\nLuis\s*\nData Engineering", text.replace("\u2028", "\n"))


def test_join_lines_turns_single_newlines_into_spaces():
    text = as_text(to_rtf("one\ntwo\n", join_lines=True))
    assert "one two" in text


def test_lists_become_real_lists():
    rtf = to_rtf(SAMPLE)
    assert "listtext" in rtf
    text = as_text(rtf)
    assert "Bullet one" in text and "First" in text


def test_font_and_size_options():
    rtf = to_rtf("hello", font="Arial", size=14)
    assert "Arial" in rtf
    assert "28" in set(re.findall(r"\\fs(\d+)", rtf))


def test_unicode_is_kept():
    text = as_text(to_rtf("Zoë’s “quote” – ok"))
    assert "Zoë’s “quote” – ok" in text


def run_cli(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, capture_output=True, text=True)


def test_cli_writes_rtf_next_to_input_without_touching_clipboard(tmp_path):
    src = tmp_path / "msg.md"
    src.write_text(SAMPLE)
    res = run_cli(str(src), "--no-copy")
    assert res.returncode == 0, res.stderr
    out = tmp_path / "msg.rtf"
    assert out.read_text(errors="replace").startswith("{\\rtf1")
    assert "wrote" in res.stderr and "clipboard" not in res.stderr


def test_cli_replaces_existing_file_and_says_so(tmp_path):
    src = tmp_path / "msg.md"
    src.write_text("hi")
    (tmp_path / "msg.rtf").write_text("old")
    res = run_cli(str(src), "--no-copy")
    assert "replaced" in res.stderr
    assert (tmp_path / "msg.rtf").read_text(errors="replace").startswith("{\\rtf1")


def test_cli_rejects_missing_empty_and_pointless_calls(tmp_path):
    assert run_cli(str(tmp_path / "nope.md")).returncode == 1
    empty = tmp_path / "e.md"
    empty.write_text("  \n")
    assert run_cli(str(empty), "--no-copy").returncode == 1
    full = tmp_path / "f.md"
    full.write_text("x")
    assert run_cli(str(full), "--no-copy", "--no-file").returncode == 2


def test_cli_stdin_without_clipboard_requires_output():
    res = run_cli("-", "--no-copy", stdin="hello")
    assert res.returncode == 2
    assert "requires --output" in res.stderr
    assert res.stdout == ""


def test_cli_stdin_writes_explicit_output_without_clipboard(tmp_path):
    dest = tmp_path / "stdin.rtf"
    res = run_cli("-", "--no-copy", "-o", str(dest), stdin=SAMPLE)
    assert res.returncode == 0, res.stderr
    assert dest.read_text(errors="replace").startswith("{\\rtf1")
    assert "wrote" in res.stderr and "clipboard" not in res.stderr


def test_cli_output_option(tmp_path):
    src = tmp_path / "a.md"
    src.write_text("x")
    dest = tmp_path / "custom.rtf"
    assert run_cli(str(src), "-o", str(dest), "--no-copy").returncode == 0
    assert dest.exists() and not (tmp_path / "a.rtf").exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
