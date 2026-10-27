#!/usr/bin/env -S uv run --script
"""Check command-center shortcuts, with optional temporary live Ghostty windows."""
# ruff: noqa: S101, S603, PLR0915, C901

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ghostty/.local/bin/ghostty-cc"
TITLE = "🎛 cc"


def run(*args: str | Path, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Bound every external command and include stderr on failures."""
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=20, check=False)
    if check and result.returncode:
        message = f"{args}: {result.stdout}{result.stderr}"
        raise AssertionError(message)
    return result


def apple(source: str) -> str:
    """Use Ghostty's own scripting dictionary."""
    return run("/usr/bin/osascript", "-e", f'tell application "Ghostty"\n{source}\nend tell').stdout.strip()


def quote(text: str) -> str:
    """Quote an AppleScript string."""
    return json.dumps(text, ensure_ascii=False)


def unit_tests() -> None:
    """Check routing, errors, locking, compilation, and unchanged copy bindings."""
    run("/bin/bash", "-n", SCRIPT)
    config = (ROOT / "ghostty/.config/ghostty/config").read_text()
    assert "keybind = cmd+shift+c=" not in config
    assert "keybind = cmd+shift+x=set_tab_title:" in config
    assert "keybind = performable:cmd+c=copy_to_clipboard" in config
    karabiner = json.loads((ROOT / "karabiner/karabiner.json").read_text())
    rules = karabiner["profiles"][0]["complex_modifications"]["rules"]
    manipulators = [m for r in rules for m in r["manipulators"]]
    marker = next(m for m in manipulators if m["from"] == {
        "key_code": "c", "modifiers": {"mandatory": ["command", "shift"]},
    })
    assert marker["from"]["modifiers"] == {"mandatory": ["command", "shift"]}
    assert marker["conditions"] == [
        {"type": "frontmost_application_if", "bundle_identifiers": [r"^com\.mitchellh\.ghostty$"]},
    ]
    assert marker["to"] == [{"shell_command": "$HOME/.local/bin/ghostty-cc mark"}]
    opener = next(m for m in manipulators if m["from"] == {
        "key_code": "c", "modifiers": {"mandatory": ["command", "control", "option", "shift"]},
    })
    assert "conditions" not in opener, "super+c must work from any app"
    assert opener["to"] == [{"shell_command": "$HOME/.local/bin/ghostty-cc"}]
    assert all("optional" not in m["from"]["modifiers"] for m in (marker, opener))
    assert not (ROOT / "raycast/.config/raycast/scripts/cc.sh").exists()
    caps = next(m for m in manipulators if m["from"]["key_code"] == "caps_lock")
    assert caps["to"] == [{"key_code": "left_shift", "modifiers": ["left_command", "left_control", "left_option"]}]
    with tempfile.TemporaryDirectory(prefix="test-cc-") as directory:
        home = Path(directory)
        cache = home / ".cache"
        cache.mkdir()
        source = SCRIPT.read_text().split("<<'APPLESCRIPT'\n", 1)[1].split("\nAPPLESCRIPT\n", 1)[0]
        src = home / "cc.applescript"
        src.write_text(source)
        assert "focus focused terminal of t" not in source, "Activation must not reuse a positional tab reference"
        assert "focus terminal id targetTerminalID" in source
        run("/usr/bin/osacompile", "-o", home / "cc.scpt", src)
        # Test the real AppleScript matcher, not a Python copy of its logic.
        matcher = source.split("on run argv", 1)[0]
        matcher += f"""on run
if not my isCommandCenter({quote(TITLE)}, {quote(TITLE)}) then error "Plain title did not match"
if not my isCommandCenter({quote('🔔 ' + TITLE)}, {quote(TITLE)}) then error "Bell title did not match"
repeat with candidate in {{{quote('prefix ' + TITLE)}, {quote(TITLE + ' suffix')}, {quote('🔔 other')}, ""}}
if my isCommandCenter(candidate as text, {quote(TITLE)}) then error "Unrelated title matched"
end repeat
return "matched"
end run
"""
        assert run("/usr/bin/osascript", "-e", matcher).stdout.strip() == "matched"
        binary = home / "bin"
        binary.mkdir()
        stub = binary / "osascript"
        stub.write_text("""#!/bin/bash
if [[ "$1" == "-e" ]]; then echo notified >> "$HOME/calls"; exit 0; fi
printf '%s\\n' "$2" >> "$HOME/calls"
/bin/cat > "$HOME/source"
# mkdir detects overlapping calls rather than merely asserting script text.
mkdir "$HOME/active" || exit 97
trap 'rmdir "$HOME/active"' EXIT
sleep 0.15
if [[ "$STUB_RESULT" == fail ]]; then exit 96; fi
printf '%s\\n' "$STUB_RESULT"
""")
        stub.chmod(0o755)
        env = {**os.environ, "HOME": str(home), "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        for mode, result in (("focus", "focused"), ("focus", "opened"), ("mark", "marked")):
            args = [] if mode == "focus" else [mode]
            run("/bin/bash", SCRIPT, *args, env={**env, "STUB_RESULT": result})
            assert (home / "calls").read_text().splitlines()[-1] == mode
            assert (cache / "cc.log").read_text().splitlines()[-1].endswith(result)
            assert not (cache / "cc.lock").exists()
        for result in ("fail", "unexpected"):
            assert run("/bin/bash", SCRIPT, env={**env, "STUB_RESULT": result}, check=False).returncode == 1
            assert (home / "calls").read_text().splitlines()[-1] == "notified"
            assert not (cache / "cc.lock").exists()
        assert run("/bin/bash", SCRIPT, "invalid", env=env, check=False).returncode == 2  # noqa: PLR2004
        (cache / "cc.lock").write_text("999999999\n")
        run("/bin/bash", SCRIPT, env={**env, "STUB_RESULT": "focused"})
        children = []
        try:
            for _ in range(4):
                children.append(  # noqa: PERF401, keep each child tracked for cleanup
                    subprocess.Popen(
                        ["/bin/bash", str(SCRIPT)],
                        env={**env, "STUB_RESULT": "focused"},
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    ),
                )
            for child in children:
                stdout, stderr = child.communicate(timeout=15)
                assert child.returncode == 0, stdout + stderr
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
        assert not (cache / "cc.lock").exists()
    print(
        "PASS: shortcut routing, exact and bell titles, copy binding, AppleScript compilation, "
        "errors, stale lock, concurrent calls",
    )


def live_tests() -> None:  # noqa: PLR0912
    """Restore existing cc tabs and focus, and close only windows created by this test."""
    assert apple("return running") == "true", "Start Ghostty before --live"
    original_window = apple("return id of front window")
    original_tab = apple("return id of selected tab of front window")
    original_windows = set(
        apple(
            "set ids to {}\nrepeat with w in windows\nset end of ids to id of w\nend repeat\n"
            'set AppleScript\'s text item delimiters to "\\n"\nreturn ids as text',
        ).splitlines(),
    )
    prefix = "test-cc-" + uuid.uuid4().hex
    saved = apple(f"""set saved to {{}}
set savedTerminals to {{}}
repeat with w in windows
repeat with t in tabs of w
if name of t is {quote(TITLE)} or name of t is {quote('🔔 ' + TITLE)} then
set end of saved to id of t
set end of savedTerminals to id of focused terminal of t
end if
end repeat
end repeat
repeat with terminalID in savedTerminals
perform action ("set_tab_title:" & {quote(prefix + "-saved")}) on terminal id (terminalID as text)
end repeat
set AppleScript's text item delimiters to "\\n"
return saved as text""").splitlines()
    created: list[str] = []

    def tabs() -> list[tuple[str, str, str]]:
        raw = apple("""set rows to ""
repeat with w in windows
repeat with t in tabs of w
set rows to rows & id of w & "|" & id of t & "|" & name of t & linefeed
end repeat
end repeat
return rows""")
        return [tuple(row.split("|", 2)) for row in raw.splitlines()]

    def marked() -> list[tuple[str, str, str]]:
        return [t for t in tabs() if t[2] == TITLE]

    def focus(tab_id: str) -> None:
        apple(f'''repeat with w in windows
repeat with t in tabs of w
if id of t is {quote(tab_id)} then
set targetTerminalID to id of focused terminal of t
activate
focus terminal id targetTerminalID
repeat 30 times
if frontmost and id of selected tab of front window is {quote(tab_id)} then
delay 0.2
if frontmost and id of selected tab of front window is {quote(tab_id)} then return
end if
delay 0.1
end repeat
error "Test tab did not become focused."
end if
end repeat
end repeat
error "Missing test tab"''')

    def window() -> tuple[str, str]:
        win = apple(
            'set w to new window with configuration '
            '{initial working directory:"/tmp", command:"/bin/sleep 600"}\nreturn id of w',
        )
        created.append(win)
        tab = apple(f"return id of selected tab of window id {quote(win)}")
        return win, tab

    with tempfile.TemporaryDirectory(prefix="test-cc-live-") as directory:
        env = {**os.environ, "HOME": directory}
        try:
            first, first_tab = window()
            second, second_tab = window()
            focus(first_tab)
            run("/bin/bash", SCRIPT, "mark", env=env)
            assert [t[1] for t in marked()] == [first_tab]
            focus(second_tab)
            run("/bin/bash", SCRIPT, "mark", env=env)
            assert [t[1] for t in marked()] == [second_tab]
            run("/bin/bash", SCRIPT, "mark", env=env)
            assert [t[1] for t in marked()] == [second_tab]
            print("PASS: marking replaces previous cc across windows; repeated marking is idempotent")

            extra = apple(
                f"set t to new tab in window id {quote(second)} with configuration "
                '{command:"/bin/sleep 600"}\nreturn id of t',
            )
            focus(extra)
            count = len(tabs())
            run("/usr/bin/osascript", "-e", 'tell application "Finder" to activate')
            apple(
                'repeat 30 times\nif not frontmost then return\ndelay 0.1\n'
                'end repeat\nerror "Finder did not activate"',
            )
            assert run("/bin/bash", SCRIPT, "mark", env=env, check=False).returncode == 1
            assert [t[1] for t in marked()] == [second_tab]
            run("/bin/bash", SCRIPT, env=env)
            assert apple("return frontmost") == "true"
            assert len(tabs()) == count
            assert apple("return id of selected tab of front window") == second_tab
            # Mark tab 2 to test clearing and finding background tabs in either position.
            focus(extra)
            run("/bin/bash", SCRIPT, "mark", env=env)
            assert [t[1] for t in marked()] == [extra]
            focus(second_tab)
            run("/bin/bash", SCRIPT, env=env)
            assert len(tabs()) == count
            assert apple("return id of selected tab of front window") == extra
            print("PASS: cc in background tab 1 or 2 is focused without opening a window")
            print("PASS: focus activates Ghostty from another app; marking outside Ghostty fails safely")

            # Use Ghostty's real title API to pin its bell decoration deterministically.
            # Ringing a real bell depends on terminal focus and bell suppression settings.
            apple(
                f'perform action "set_tab_title:🔔 {TITLE}" on focused terminal '
                f"of tab id {quote(extra)} of window id {quote(second)}",
            )
            focus(first_tab)
            run("/bin/bash", SCRIPT, env=env)
            assert len(tabs()) == count, "A bell title opened a duplicate window"
            assert apple("return id of selected tab of front window") == extra
            focus(first_tab)
            run("/bin/bash", SCRIPT, "mark", env=env)
            assert [t[1] for t in marked()] == [first_tab]
            assert apple(f"return name of tab id {quote(extra)} of window id {quote(second)}") != "🔔 " + TITLE
            print("PASS: bell-decorated cc is focused and reassigned without a duplicate window")
            apple(
                f'perform action "set_tab_title:" on focused terminal '
                f"of tab id {quote(first_tab)} of window id {quote(first)}",
            )

            # Reproduce a title lookup that briefly misses an existing command center.
            # The setter waits until the helper holds its lock, then publishes the title.
            apple(
                f'perform action "set_tab_title:{prefix}-pending" on focused terminal '
                f"of tab id {quote(extra)} of window id {quote(second)}",
            )
            focus(first_tab)
            setter = subprocess.Popen(
                ["/bin/bash", "-c", """
for ((attempt = 0; attempt < 200; attempt++)); do
  if [[ -f "$1/.cache/cc.lock" ]]; then
    sleep 0.3
    exec /usr/bin/osascript -e "$2"
  fi
  sleep 0.01
done
exit 1
""", "test-cc-title", directory,
                 'tell application "Ghostty" to perform action "set_tab_title:' + TITLE + '" '
                 f"on focused terminal of tab id {quote(extra)} of window id {quote(second)}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                run("/bin/bash", SCRIPT, env=env)
                stdout, stderr = setter.communicate(timeout=10)
                assert setter.returncode == 0, stdout + stderr
                assert len(tabs()) == count, "A delayed title lookup opened a duplicate window"
                assert apple("return id of selected tab of front window") == extra
                assert [t[1] for t in marked()] == [extra]
                assert (Path(directory) / ".cache/cc.log").read_text().splitlines()[-1].endswith("focused")
            finally:
                if setter.poll() is None:
                    setter.kill()
                    setter.wait(timeout=5)
            print("PASS: delayed cc title is retried without opening a duplicate window")

            apple(
                f'perform action "set_tab_title:" on focused terminal '
                f"of tab id {quote(extra)} of window id {quote(second)}",
            )
            assert not marked()
            children = []
            try:
                for _ in range(4):
                    children.append(  # noqa: PERF401, track each caller for cleanup
                        subprocess.Popen(["/bin/bash", str(SCRIPT)], env=env,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True),
                    )
                for child in children:
                    stdout, stderr = child.communicate(timeout=15)
                    assert child.returncode == 0, stdout + stderr
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
            new_marks = marked()
            assert len(new_marks) == 1
            opened, opened_tab, _ = new_marks[0]
            assert opened not in original_windows
            assert opened not in created
            created.append(opened)
            assert (
                apple(
                    "return working directory of focused terminal "
                    f"of tab id {quote(opened_tab)} of window id {quote(opened)}",
                )
                == directory
            )
            for _ in range(3):
                focus(first_tab)
                run("/bin/bash", SCRIPT, env=env)
                assert marked() == new_marks
                assert len(tabs()) == count + 1
                assert apple("return id of front window") == opened
            print("PASS: concurrent missing-target calls create one home window; repeated focus does not duplicate it")
            apple(f"close window window id {quote(opened)}")
            created.remove(opened)
            run("/bin/bash", SCRIPT, env=env)
            replacement = marked()
            assert len(replacement) == 1
            created.append(replacement[0][0])
            assert replacement[0][0] != opened
            print("PASS: closing cc allows a new command center")
        finally:
            # An assertion can fail immediately after open. Find only our home fixture windows.
            for win, tab, _title in tabs():
                if win not in original_windows and win not in created:
                    cwd = apple(
                        "return working directory of focused terminal "
                        f"of tab id {quote(tab)} of window id {quote(win)}",
                    )
                    if cwd == directory:
                        created.append(win)
            for win in created:
                apple(f"if exists window id {quote(win)} then close window window id {quote(win)}")
            for tab in saved:
                apple(f"""set savedTerminalID to missing value
repeat with w in windows
repeat with t in tabs of w
if id of t is {quote(tab)} then set savedTerminalID to id of focused terminal of t
end repeat
end repeat
if savedTerminalID is not missing value then
perform action ("set_tab_title:" & {quote(TITLE)}) on terminal id savedTerminalID
end if""")
            focus(original_tab)
            assert apple("return id of front window") == original_window
            assert {t[0] for t in tabs()} == original_windows
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and {t[1] for t in marked()} != set(saved):
                time.sleep(0.05)
            assert {t[1] for t in marked()} == set(saved)
    print("PASS: original windows, cc designation, and focused tab restored; test windows closed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="also exercise the running Ghostty app")
    args = parser.parse_args()
    unit_tests()
    if args.live:
        live_tests()
