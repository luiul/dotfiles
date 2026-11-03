#!/usr/bin/env -S uv run --script
"""Check remaining Ghostty shortcuts and the VS Code launcher without opening user windows."""
# ruff: noqa: S101, S603

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlparse

if TYPE_CHECKING:
    from collections.abc import Callable

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ghostty/.local/bin/ghostty-open-vscode"


def run(*args: str | Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Bound each subprocess and return its exit status for assertions."""
    return subprocess.run(args, capture_output=True, text=True, check=False, env=env, timeout=15)


def is_removed_shortcut(manipulator: dict) -> bool:
    """Match only Super+C globally and Cmd+Shift+C in Ghostty."""
    source = manipulator.get("from", {})
    if source.get("key_code") != "c":
        return False
    modifiers = set(source.get("modifiers", {}).get("mandatory", []))
    if modifiers == {"command", "control", "option", "shift"}:
        return True
    return modifiers == {"command", "shift"} and any(
        condition.get("type") == "frontmost_application_if"
        and r"^com\.mitchellh\.ghostty$" in condition.get("bundle_identifiers", [])
        for condition in manipulator.get("conditions", [])
    )


def check_bindings() -> None:
    """Check shortcut removal and preserve the remaining Ghostty bindings."""
    config = json.loads((ROOT / "karabiner/karabiner.json").read_text())
    manipulators = [
        m for profile in config["profiles"]
        for rule in profile.get("complex_modifications", {}).get("rules", [])
        for m in rule["manipulators"]
    ]
    assert not any("ghostty-cc" in json.dumps(m) for m in manipulators)
    assert not any(is_removed_shortcut(m) for m in manipulators)
    assert not is_removed_shortcut({"from": {"key_code": "c", "modifiers": {"mandatory": ["command"]}}})
    assert not is_removed_shortcut({"from": {"key_code": "c", "modifiers": {"mandatory": ["command", "shift"]}}})
    assert not (ROOT / "ghostty/.local/bin/ghostty-cc").exists()
    assert not (ROOT / "scripts/test-cc.py").exists()
    caps = [m for m in manipulators if m["from"]["key_code"] == "caps_lock"]
    assert len(caps) == 1
    assert caps[0]["from"]["modifiers"] == {"optional": ["any"]}
    assert caps[0]["to"] == [
        {"key_code": "left_shift", "modifiers": ["left_command", "left_control", "left_option"]},
    ]
    ghostty = (ROOT / "ghostty/.config/ghostty/config").read_text()
    assert "ghostty-cc" not in ghostty
    assert "keybind = cmd+shift+c=" not in ghostty
    assert "keybind = cmd+shift+x=set_tab_title:" in ghostty
    assert "keybind = performable:cmd+c=copy_to_clipboard" in ghostty
    assert "keybind = global:control+command+shift+option+r=toggle_quick_terminal" in ghostty
    bindings = [m for m in manipulators if m["from"]["key_code"] == "e"]
    assert len(bindings) == 1
    binding = bindings[0]
    assert binding["from"]["modifiers"] == {"mandatory": ["command"]}
    assert binding["to"] == [{"shell_command": "$HOME/.local/bin/ghostty-open-vscode"}]
    assert binding["conditions"] == [
        {"type": "frontmost_application_if", "bundle_identifiers": [r"^com\.mitchellh\.ghostty$"]},
    ]


def write_live_osascript(path: Path, notifications: Path, real: Path = Path("/usr/bin/osascript")) -> None:
    """Keep real lookups, but record test notifications instead of showing them."""
    path.write_text(
        "#!/bin/bash\n"
        'if [[ "$1" == "-e" && "$2" == "display notification "* ]]; then\n'
        f"  printf '%s\\n' \"$2\" >> {shlex.quote(str(notifications))}\n"
        "  exit 0\n"
        "fi\n"
        f'exec {shlex.quote(str(real))} "$@"\n',
    )
    path.chmod(0o755)


def check_live_osascript() -> None:
    """Check that the live test forwards lookups and never shows error popups."""
    with tempfile.TemporaryDirectory(prefix="test-live-osascript-") as directory:
        home = Path(directory)
        real = home / "real osascript"
        real.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$HOME/forwarded"\nexit 7\n')
        real.chmod(0o755)
        wrapper = home / "osascript"
        notifications = home / "notifications"
        write_live_osascript(wrapper, notifications, real)
        env = {**os.environ, "HOME": directory}
        result = run(wrapper, "-e", 'display notification "Fixture failure"', env=env)
        assert result.returncode == 0
        assert not (home / "forwarded").exists()
        assert notifications.read_text() == 'display notification "Fixture failure"\n'
        result = run(wrapper, "-e", 'tell application "Ghostty" to return running', env=env)
        assert result.returncode == 7  # noqa: PLR2004
        assert (home / "forwarded").read_text() == '-e\ntell application "Ghostty" to return running\n'
        assert run(wrapper, env=env).returncode == 7  # noqa: PLR2004
        notifications.unlink()
        result = run("/bin/bash", SCRIPT, env={**env, "PATH": directory + ":/usr/bin:/bin"})
        assert result.returncode == 1
        assert "Could not read the focused Ghostty directory." in result.stderr
        assert notifications.read_text().startswith('display notification "Could not open the Ghostty directory')
    print("PASS: live test notifications stay in fixture logs; lookup arguments and errors pass through")


def finish_cleanup(actions: list[Callable[[], None]], original_error: BaseException | None = None) -> None:
    """Run every cleanup action and keep the original test failure when present."""
    errors = []
    for action in actions:
        try:
            action()
        except Exception as error:  # noqa: BLE001, one failure must not skip the remaining cleanup
            errors.append(error)
    if errors:
        if original_error is not None:
            for error in errors:
                original_error.add_note(f"Cleanup failed: {error}")
        else:
            message = "Live fixture cleanup failed"
            raise ExceptionGroup(message, errors)


def check_cleanup() -> None:
    """Check that cleanup failures do not skip window closure or hide test failures."""
    calls = []

    def fail() -> None:
        calls.append("editor")
        message = "fixture editor failed to stop"
        raise AssertionError(message)

    actions = [fail, lambda: calls.append("launcher"), lambda: calls.append("window"), lambda: calls.append("focus")]
    original = AssertionError("original test failure")
    finish_cleanup(actions, original)
    assert calls == ["editor", "launcher", "window", "focus"]
    assert str(original) == "original test failure"
    assert original.__notes__ == ["Cleanup failed: fixture editor failed to stop"]
    calls.clear()
    try:
        finish_cleanup(actions)
    except ExceptionGroup as error:
        assert len(error.exceptions) == 1  # noqa: PT017, this standalone script does not use pytest
    else:
        message = "Cleanup failure was lost"
        raise AssertionError(message)
    assert calls == ["editor", "launcher", "window", "focus"]
    print("PASS: failed editor cleanup cannot skip window closure or replace the original test failure")


def main() -> None:
    """Check binding scope, directory quoting, errors, and AppleScript syntax."""
    check_bindings()
    check_live_osascript()
    check_cleanup()
    assert run("/bin/bash", "-n", SCRIPT).returncode == 0
    with tempfile.TemporaryDirectory(prefix="test-ghostty-code-") as directory:
        home = Path(directory)
        folder = home / "repo" / "nested space ' quote; $(touch NOT_EXECUTED)"
        folder.mkdir(parents=True)
        binary = home / "bin"
        binary.mkdir()
        source = SCRIPT.read_text().split("<<'APPLESCRIPT'\n", 1)[1].split("\nAPPLESCRIPT\n", 1)[0]
        src = home / "launcher.applescript"
        src.write_text(source)
        assert run("/usr/bin/osacompile", "-o", home / "launcher.scpt", src).returncode == 0
        assert "working directory of focused terminal of selected tab of front window" in source
        stub = binary / "osascript"
        stub.write_text("""#!/bin/bash
if [[ "$1" == "-e" ]]; then echo notified >> "$HOME/notified"; exit 0; fi
/bin/cat > "$HOME/source"
if [[ "$STUB_ERROR" == yes ]]; then exit 1; fi
printf '%s\\n' "$STUB_CWD"
""")
        stub.chmod(0o755)
        code = binary / "code"
        code.write_text("""#!/bin/bash
printf '%s\\0' "$@" > "$HOME/code-args"
exit "${CODE_EXIT:-0}"
""")
        code.chmod(0o755)
        env = {**os.environ, "HOME": directory, "PATH": str(binary) + ":/usr/bin:/bin", "STUB_CWD": str(folder)}
        result = run("/bin/bash", SCRIPT, env=env)
        assert result.returncode == 0, result.stderr
        assert (home / "code-args").read_bytes() == os.fsencode(folder) + b"\0"
        assert not (home / "notified").exists()
        assert not (home / "NOT_EXECUTED").exists()
        print("PASS: exact nested directory with spaces, quotes, and shell characters is one code argument")
        cases = (
            {"STUB_ERROR": "yes"},
            {"STUB_CWD": ""},
            {"STUB_CWD": "relative/path"},
            {"STUB_CWD": str(home / "missing")},
        )
        for case in cases:
            (home / "code-args").unlink(missing_ok=True)
            (home / "notified").unlink(missing_ok=True)
            assert run("/bin/bash", SCRIPT, env={**env, **case}).returncode == 1
            assert not (home / "code-args").exists()
            assert (home / "notified").read_text() == "notified\n"
        assert run("/bin/bash", SCRIPT, env={**env, "CODE_EXIT": "1"}).returncode == 1
        print("PASS: failed lookup, missing directory, and code failure show a notification")
    print("PASS: cc workflow absent; Caps Lock, title clearing, copy, and quick terminal bindings preserved")
    print("PASS: Ghostty-only cmd+e routing, shell syntax, and AppleScript compilation")


def live_test() -> None:  # noqa: C901, PLR0915
    """Open a temporary focused split in a separate VS Code instance, then clean up."""
    def apple(source: str) -> str:
        result = run("/usr/bin/osascript", "-e", f'tell application "Ghostty"\n{source}\nend tell')
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def quote(text: str) -> str:
        return json.dumps(text, ensure_ascii=False)

    original_terminal = apple("return id of focused terminal of selected tab of front window")
    windows_before = int(apple("return count of windows"))
    code_cli = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    assert Path(code_cli).is_file()
    with tempfile.TemporaryDirectory(prefix="ghostty-code-live-", dir="/tmp") as directory:
        fixture = Path(directory).resolve()
        folder = fixture / "nested folder ' split"
        folder.mkdir()
        user_data = fixture / "code-user-data"
        (user_data / "User").mkdir(parents=True)
        (user_data / "User/settings.json").write_text(json.dumps({"security.workspace.trust.enabled": False}))
        binary = fixture / "bin"
        binary.mkdir()
        code = binary / "code"
        code.write_text(
            "#!/bin/bash\n"
            f"printf '%s\\n' \"$@\" > {shlex.quote(str(fixture / 'code-called'))}\n"
            f'exec {shlex.quote(code_cli)} --verbose --user-data-dir {shlex.quote(str(user_data))} '
            f'--disable-extensions --new-window "$@" > {shlex.quote(str(fixture / "code-log"))} 2>&1\n',
        )
        code.chmod(0o755)
        write_live_osascript(binary / "osascript", fixture / "notifications")
        env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        win = apple(
            'set w to new window with configuration {initial working directory:"/tmp", command:"/bin/sleep 120"}\n'
            "return id of w",
        )
        launcher = None
        try:
            split_command = shlex.join([
                "/bin/sh", "-c",
                (
                    f"cd {shlex.quote(str(folder))} && "
                    "printf '\\033]7;kitty-shell-cwd://localhost%s\\007' \"$PWD\"; exec /bin/sleep 120"
                ),
            ])
            target = apple(
                f"set t to new tab in window id {quote(win)} "
                f'with configuration {{initial working directory:{quote(str(fixture))}, command:"/bin/sleep 120"}}\n'
                "set term to split focused terminal of t direction right "
                f"with configuration {{initial working directory:{quote(str(folder))}, "
                f"command:{quote(split_command)}}}\n"
                "return id of term",
            )
            apple(f"activate\nfocus terminal id {quote(target)}")
            apple(
                "repeat 30 times\n"
                "if frontmost and id of focused terminal of selected tab of front window is "
                f"{quote(target)} then return\n"
                'delay 0.1\nend repeat\nerror "Fixture terminal did not become frontmost."',
            )
            deadline = time.monotonic() + 5
            actual = ""
            while time.monotonic() < deadline:
                actual = apple(f"return working directory of terminal id {quote(target)}")
                if actual == str(folder):
                    break
                time.sleep(0.1)
            assert actual == str(folder), repr(actual)
            assert apple("return id of focused terminal of selected tab of front window") == target
            assert apple("return frontmost") == "true"
            launcher = subprocess.Popen(["/bin/bash", str(SCRIPT)], env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 25
            found = False
            while time.monotonic() < deadline:
                if launcher.poll() not in (None, 0):
                    stdout, stderr = launcher.communicate(timeout=5)
                    message = f"VS Code launcher failed (exit {launcher.returncode}):\n{stdout}{stderr}"
                    raise AssertionError(message)
                for workspace in (user_data / "User/workspaceStorage").glob("*/workspace.json"):
                    try:
                        uri = json.loads(workspace.read_text()).get("folder", "")
                    except (OSError, json.JSONDecodeError):
                        # VS Code can expose the file before its first write finishes.
                        continue
                    if unquote(urlparse(uri).path) == str(folder):
                        found = True
                        break
                if found:
                    break
                time.sleep(0.2)
            if not found:
                logs = list((user_data / "logs").rglob("*.log"))
                details = "\n".join(f"{p.name}: {p.read_text(errors='replace')[-1500:]}" for p in logs)
                for name in ("code-log", "notifications"):
                    path = fixture / name
                    content = path.read_text(errors="replace")[:4000] if path.exists() else "not created"
                    details += f"\n{name}: {content}"
                message = f"VS Code did not open the focused split directory.\n{details}"
                raise AssertionError(message)
            assert not (fixture / "notifications").exists(), "The launcher tried to show an error notification"
            print("PASS: real Ghostty background tab and split directory opened in an isolated VS Code window")
        finally:
            def stop_editor() -> None:
                # Only terminate the separate main process with this unique user-data-dir.
                ps = run("/bin/ps", "-axo", "pid=,args=")
                assert ps.returncode == 0, ps.stderr
                owned_pids = []
                for line in ps.stdout.splitlines():
                    if "Visual Studio Code.app/Contents/MacOS/Code" in line and str(user_data) in line:
                        pid = int(line.strip().split(None, 1)[0])
                        owned_pids.append(pid)
                        with contextlib.suppress(ProcessLookupError):
                            os.kill(pid, 15)
                deadline = time.monotonic() + 10
                while owned_pids and time.monotonic() < deadline:
                    owned_pids = [pid for pid in owned_pids if run("/bin/ps", "-p", str(pid)).returncode == 0]
                    if owned_pids:
                        time.sleep(0.2)
                assert not owned_pids, "The isolated VS Code process did not stop"

            def stop_launcher() -> None:
                if launcher is not None:
                    if launcher.poll() is None:
                        with contextlib.suppress(ProcessLookupError):
                            launcher.terminate()
                    try:
                        launcher.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        with contextlib.suppress(ProcessLookupError):
                            launcher.kill()
                        launcher.communicate(timeout=5)

            def check_windows() -> None:
                assert int(apple("return count of windows")) == windows_before

            finish_cleanup([
                stop_editor,
                stop_launcher,
                lambda: apple(f"if exists window id {quote(win)} then close window window id {quote(win)}"),
                lambda: apple(f"activate\nfocus terminal id {quote(original_terminal)}"),
                check_windows,
            ], sys.exception())
    print("PASS: isolated VS Code stopped, temporary Ghostty window closed, original tab restored")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="also open a temporary isolated VS Code instance")
    args = parser.parse_args()
    main()
    if args.live:
        live_test()
