#!/usr/bin/env -S uv run --script
"""Check Ghostty's cmd+e binding and VS Code launcher without opening user windows."""
# ruff: noqa: S101, S603

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "ghostty/.local/bin/ghostty-open-vscode"


def run(*args: str | Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Bound each subprocess and return its exit status for assertions."""
    return subprocess.run(args, capture_output=True, text=True, check=False, env=env, timeout=15)


def main() -> None:
    """Check binding scope, directory quoting, errors, and AppleScript syntax."""
    assert run("/bin/bash", "-n", SCRIPT).returncode == 0
    config = json.loads((ROOT / "karabiner/karabiner.json").read_text())
    rules = config["profiles"][0]["complex_modifications"]["rules"]
    bindings = [m for rule in rules for m in rule["manipulators"] if m["from"]["key_code"] == "e"]
    assert len(bindings) == 1
    binding = bindings[0]
    assert binding["from"]["modifiers"] == {"mandatory": ["command"]}
    assert binding["to"] == [{"shell_command": "$HOME/.local/bin/ghostty-open-vscode"}]
    assert binding["conditions"] == [
        {"type": "frontmost_application_if", "bundle_identifiers": [r"^com\.mitchellh\.ghostty$"]},
    ]
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
    print("PASS: Ghostty-only cmd+e routing, shell syntax, and AppleScript compilation")


def live_test() -> None:  # noqa: C901, PLR0912, PLR0915
    """Open a temporary focused split in a separate VS Code instance, then clean up."""
    def apple(source: str) -> str:
        result = run("/usr/bin/osascript", "-e", f'tell application "Ghostty"\n{source}\nend tell')
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def quote(text: str) -> str:
        return json.dumps(text, ensure_ascii=False)

    original_tab = apple("return id of selected tab of front window")
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
        env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        win = apple(
            'set w to new window with configuration {initial working directory:"/tmp", command:"/bin/sleep 120"}\n'
            "return id of w",
        )
        launcher = None
        try:
            split_command = shlex.join(["/bin/zsh", "-ic", "exec /bin/sleep 120"])
            target = apple(
                f"set t to new tab in window id {quote(win)} "
                f'with configuration {{initial working directory:{quote(str(fixture))}, command:"/bin/sleep 120"}}\n'
                "set term to split focused terminal of t direction right "
                f"with configuration {{initial working directory:{quote(str(folder))}, "
                f"command:{quote(split_command)}}}\n"
                "activate\nfocus term\nreturn id of term",
            )
            apple("repeat 30 times\nif frontmost then return\ndelay 0.1\nend repeat")
            assert apple("return id of focused terminal of selected tab of front window") == target
            deadline = time.monotonic() + 5
            actual = ""
            while time.monotonic() < deadline:
                actual = apple("return working directory of focused terminal of selected tab of front window")
                if actual == str(folder):
                    break
                time.sleep(0.1)
            assert actual == str(folder), repr(actual)
            launcher = subprocess.Popen(["/bin/bash", str(SCRIPT)], env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 25
            found = False
            while time.monotonic() < deadline:
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
                details += (fixture / "code-log").read_text(errors="replace")[:4000]
                message = f"VS Code did not open the focused split directory.\n{details}"
                raise AssertionError(message)
            print("PASS: real Ghostty background tab and split directory opened in an isolated VS Code window")
        finally:
            # Only terminate the separate main process with this unique user-data-dir.
            ps = run("/bin/ps", "-axo", "pid=,args=")
            owned_pids = []
            for line in ps.stdout.splitlines():
                if "Visual Studio Code.app/Contents/MacOS/Code" in line and str(user_data) in line:
                    pid = int(line.strip().split(None, 1)[0])
                    owned_pids.append(pid)
                    os.kill(pid, 15)
            deadline = time.monotonic() + 10
            while owned_pids and time.monotonic() < deadline:
                owned_pids = [pid for pid in owned_pids if run("/bin/ps", "-p", str(pid)).returncode == 0]
                if owned_pids:
                    time.sleep(0.2)
            assert not owned_pids, "The isolated VS Code process did not stop"
            if launcher is not None:
                if launcher.poll() is None:
                    launcher.terminate()
                launcher.communicate(timeout=5)
            apple(f"if exists window id {quote(win)} then close window window id {quote(win)}")
            apple(
                "repeat with w in windows\nrepeat with t in tabs of w\n"
                f"if id of t is {quote(original_tab)} then\nactivate\nfocus focused terminal of t\n"
                "return\nend if\nend repeat\nend repeat",
            )
            assert int(apple("return count of windows")) == windows_before
    print("PASS: isolated VS Code stopped, temporary Ghostty window closed, original tab restored")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="also open a temporary isolated VS Code instance")
    args = parser.parse_args()
    main()
    if args.live:
        live_test()
