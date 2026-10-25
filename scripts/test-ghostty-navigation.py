#!/usr/bin/env -S uv run --script
"""Exercise installed dashboard Enter keys in tmux without touching real app windows."""
# ruff: noqa: S101, S603, PLR0915

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


def main() -> None:
    """Run each installed dashboard against isolated process and window fixtures."""
    tmux = shutil.which("tmux")
    git = shutil.which("git")
    assert tmux, "tmux must be installed"
    assert git, "git must be installed"
    real_home = Path.home()
    with tempfile.TemporaryDirectory(prefix="ghostty-navigation-") as directory:
        fixture = Path(directory).resolve()
        home = fixture / "home"
        home.mkdir()
        repo = home / "nav-fixture"
        repo.mkdir()
        subprocess.run([git, "init", "-q", "-b", "main", str(repo)], check=True, timeout=10)
        subprocess.run(
            [git, "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
             "commit", "-q", "--allow-empty", "-m", "fixture"],
            check=True,
            timeout=10,
        )
        registry = home / ".cache/wt/known-repos"
        registry.parent.mkdir(parents=True)
        registry.write_text(str(repo) + "\n")
        (home / ".config/worktrunk").mkdir(parents=True)
        (home / ".config/worktrunk/config.toml").write_text('worktree-path = "../{{ repo }}.{{ branch }}"\n')
        bin_dir = fixture / "bin"
        bin_dir.mkdir()
        editor_calls = fixture / "editor-calls"
        log = fixture / "window-calls"
        opened = fixture / "window-open"
        title = str(repo) + " • main • ttys999"
        scripts = {
            "code": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$EDITOR_CALLS"\nexit 99\n',
            "ps": """#!/bin/sh
case "$*" in
  *pid=,tty=,args=*) printf '400001 ttys999 pi\n' ;;
  *) printf '400001 1 0.0 1024 00:10 ttys999 S /fixture/pi\n' ;;
esac
""",
            "lsof": '#!/bin/sh\nprintf "p400001\\nn%s\\n" "$TEST_REPO"\n',
            "osascript": """#!/bin/sh
printf '%s\n' "$2" >> "$WINDOW_LOG"
case "$2" in
  *'new window with configuration'*) touch "$WINDOW_OPEN"; printf 'created\n' ;;
  *AXRaise*) printf 'true\n' ;;
  *'ASCII character 31'*)
    if [ -f "$WINDOW_OPEN" ]; then printf '1\\037%s\\036' "$WINDOW_TITLE"; else printf '0\\037'; fi ;;
  *) printf 'Unexpected osascript call\n' >&2; exit 98 ;;
esac
""",
        }
        for name, content in scripts.items():
            path = bin_dir / name
            path.write_text(content)
            path.chmod(0o755)
        env = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "EDITOR_CALLS": str(editor_calls),
            "TEST_REPO": str(repo),
            "WINDOW_LOG": str(log),
            "WINDOW_OPEN": str(opened),
            "WINDOW_TITLE": title,
        }

        def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
            return subprocess.run(args, check=check, capture_output=True, text=True, timeout=10)

        for tool in ("canopy", "understory"):
            binary = real_home / ".local/bin" / tool
            assert binary.exists()
            opened.unlink(missing_ok=True)
            log.unlink(missing_ok=True)
            session = f"ag-ghostty-{tool}-{os.getpid()}"
            command = "env " + " ".join(shlex.quote(f"{key}={value}") for key, value in env.items())
            command += " " + shlex.quote(str(binary)) + " --interval 1 --no-color"
            command += " --no-bell" if tool == "canopy" else " --show-main"
            run(tmux, "new-session", "-d", "-s", session, "-c", str(repo), "-x", "200", "-y", "32", command)
            try:
                def screen(session=session) -> str:
                    return run(tmux, "capture-pane", "-t", session, "-p").stdout

                def wait_for(text: str, tool=tool) -> str:
                    deadline = time.monotonic() + 25
                    last = ""
                    while time.monotonic() < deadline:
                        last = screen()
                        if text in last:
                            return last
                        time.sleep(0.2)
                    message = f"{tool}: missing {text!r} in screen:\n{last}"
                    raise AssertionError(message)

                wait_for("nav-fixture")
                if tool == "canopy":
                    wait_for("400001")
                run(tmux, "send-keys", "-t", session, "Enter")
                wait_for("Opened a new Ghostty window")
                # Let the first notification's clear timer finish before the next action.
                time.sleep(5)
                run(tmux, "send-keys", "-t", session, "Enter")
                wait_for("Focused Ghostty window")
                calls = log.read_text()
                assert calls.count("new window with configuration") == 1
                assert "AXRaise" in calls
                assert 'tell application "Ghostty"' in calls
                assert "Visual Studio Code" not in calls
                assert not editor_calls.exists(), "A dashboard launched VS Code"
                print(f"PASS: installed {tool} Enter opens once, then reuses Ghostty by window title")
                run(tmux, "send-keys", "-t", session, "q")
            finally:
                run(tmux, "kill-session", "-t", session, check=False)
                assert run(tmux, "has-session", "-t", session, check=False).returncode != 0
        print("PASS: no real app window was touched; fixture tmux sessions stopped")


if __name__ == "__main__":
    main()
