#!/usr/bin/env -S uv run --script
"""Exercise piw in running Ghostty with a fake Pi executable and a fresh zsh."""
# ruff: noqa: S101, S603

from __future__ import annotations

import argparse
import contextlib
import json
import os
import pty
import re
import select
import shlex
import signal
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def apple(source: str) -> str:
    """Run a bounded Ghostty query."""
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", f'tell application "Ghostty"\n{source}\nend tell'],
        capture_output=True, text=True, check=True, timeout=10,
    )
    return result.stdout.strip()


def test_buffered_input() -> None:
    """Run the unchanged boot command in a PTY and check input does not reach Pi."""
    source = (ROOT / "zsh/.zsh_config/funcs.zsh").read_text()
    match = re.search(r"local boot='([^\n]+)'", source)
    assert match is not None
    with tempfile.TemporaryDirectory(prefix="piw-input-", dir="/tmp") as directory:
        marker = Path(directory) / "result"
        fake = Path(directory) / "pi"
        fake.write_text(
            "#!/bin/zsh -f\n"
            "if read -k1 -t 0.1 pending; then result=leaked; else result=drained; fi\n"
            f'print -r -- "$result" > {shlex.quote(str(marker))}\n',
        )
        fake.chmod(0o755)
        boot = match.group(1).replace("exec pi", "exec " + shlex.quote(str(fake)))
        pid, master = pty.fork()
        if pid == 0:
            os.execv("/bin/zsh", ["/bin/zsh", "-f", "-ic", "sleep 0.2; " + boot])  # noqa: S606
        reaped = False
        try:
            os.write(master, b"buffered prompt\n")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    with contextlib.suppress(OSError):
                        os.read(master, 4096)
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    reaped = True
                    assert os.waitstatus_to_exitcode(status) == 0
                    break
            assert reaped, "The buffered-input fixture did not finish"
            assert marker.read_text().strip() == "drained", "Buffered input reached the Pi fixture"
        finally:
            if not reaped:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(master)
    print("PASS: queued prompt input is discarded before Pi starts")


def main(*, benchmark: bool = False) -> None:  # noqa: C901, PLR0912, PLR0915
    """Restore the original tab and close only test-created windows."""
    assert apple("return running") == "true", "Start Ghostty before testing"
    original_tab = apple("return id of selected tab of front window")
    before = set(apple(
        'set ids to {}\nrepeat with w in windows\nset end of ids to id of w\nend repeat\n'
        'set AppleScript\'s text item delimiters to "\\n"\nreturn ids as text',
    ).splitlines())
    with tempfile.TemporaryDirectory(prefix="piw-live-", dir="/tmp") as directory:
        fixture = Path(directory).resolve()
        folder = fixture / "nested folder ' quote"
        folder.mkdir()
        binary = fixture / "bin"
        binary.mkdir()
        marker = fixture / "started"
        shell_marker = fixture / "shell-ready"
        fake_pi = binary / "pi"
        fake_pi.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$PWD\" > {shlex.quote(str(marker))}\nexec /bin/sleep 30\n")
        fake_pi.chmod(0o755)
        baseline = fixture / "baseline.zsh"
        if benchmark:
            baseline.write_text(subprocess.run(
                ["/usr/bin/git", "-C", str(ROOT), "show", "HEAD:zsh/.zsh_config/funcs.zsh"],
                capture_output=True, text=True, check=True, timeout=10,
            ).stdout)
        sources = {"current": ROOT / "zsh/.zsh_config/funcs.zsh"}
        if benchmark:
            sources["HEAD"] = baseline
        measurements: dict[str, list[tuple[float, float]]] = {name: [] for name in sources}
        # AppleScript windows inherit Ghostty's environment, not the caller's PATH.
        # Replace only `exec pi` at the launch boundary, then forward to real osascript.
        launch = r"""source "$1"
osascript() {
  if [[ $1 == -e ]]; then command /usr/bin/osascript "$@"; return; fi
  local boot=${3/exec pi/[[ -o interactive ]] \&\& command -v pi > $PIW_SHELL_MARKER; exec $PIW_FAKE_PI}
  command /usr/bin/osascript "$1" "$2" "$boot"
}
piw "$2"
"""
        env = {**os.environ, "PIW_FAKE_PI": shlex.quote(str(fake_pi)),
               "PIW_SHELL_MARKER": shlex.quote(str(shell_marker))}
        try:
            for round_number in range(3 if benchmark else 1):
                names = list(sources)
                if round_number % 2:
                    names.reverse()
                for name in names:
                    marker.unlink(missing_ok=True)
                    shell_marker.unlink(missing_ok=True)
                    started = time.time()
                    returned = time.monotonic()
                    result = subprocess.run(
                        ["/bin/zsh", "-f", "-c", launch, "piw-test", str(sources[name]), str(folder)],
                        env=env, capture_output=True, text=True, check=False, timeout=15,
                    )
                    returned = (time.monotonic() - returned) * 1000
                    assert result.returncode == 0, result.stderr
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline and not marker.exists():
                        time.sleep(0.05)
                    assert marker.exists(), "The fake Pi did not start"
                    ready = (marker.stat().st_mtime_ns / 1e9 - started) * 1000
                    assert marker.read_text().strip() == str(folder)
                    assert shell_marker.exists(), "The shell was not interactive"
                    resolved_pi = shell_marker.read_text().strip()
                    assert resolved_pi, "The fresh shell could not resolve Pi"
                    assert Path(resolved_pi).is_file(), "The resolved Pi executable does not exist"
                    measurements[name].append((returned, ready))
                    current = set(apple(
                        'set ids to {}\nrepeat with w in windows\nset end of ids to id of w\nend repeat\n'
                        'set AppleScript\'s text item delimiters to "\\n"\nreturn ids as text',
                    ).splitlines())
                    owned = [
                        win for win in current - before
                        if apple(
                            f"return working directory of terminal 1 of window id {json.dumps(win)}",
                        ) == str(folder)
                    ]
                    assert len(owned) == 1, f"Expected one fixture window, got {owned}"
                    apple(f"close window window id {json.dumps(owned[0])}")
            print("PASS: real piw loads an interactive shell, resolves Pi, and uses the exact nested directory")
            if benchmark:
                for name, samples in measurements.items():
                    for index, metric in enumerate(("launch return", "fake Pi ready")):
                        values = [sample[index] for sample in samples]
                        print(f"{name} {metric}: median {statistics.median(values):.1f} ms, "
                              f"range {min(values):.1f}..{max(values):.1f}, n={len(values)}")
        finally:
            current = set(apple(
                'set ids to {}\nrepeat with w in windows\nset end of ids to id of w\nend repeat\n'
                'set AppleScript\'s text item delimiters to "\\n"\nreturn ids as text',
            ).splitlines())
            for win in current - before:
                tracked_dir = apple(
                    f"return working directory of terminal 1 of window id {json.dumps(win)}",
                )
                if tracked_dir == str(folder):
                    apple(f"close window window id {json.dumps(win)}")
            remaining = set(apple(
                'set ids to {}\nrepeat with w in windows\nset end of ids to id of w\nend repeat\n'
                'set AppleScript\'s text item delimiters to "\\n"\nreturn ids as text',
            ).splitlines())
            for win in remaining - before:
                assert apple(
                    f"return working directory of terminal 1 of window id {json.dumps(win)}",
                ) != str(folder), "The temporary piw window did not close"
            apple(
                "repeat with w in windows\nrepeat with t in tabs of w\n"
                f"if id of t is {json.dumps(original_tab)} then\nactivate\nfocus focused terminal of t\n"
                "return\nend if\nend repeat\nend repeat",
            )
    print("PASS: temporary Ghostty window closed and original tab restored")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true", help="compare three rotating launches with HEAD")
    args = parser.parse_args()
    test_buffered_input()
    main(benchmark=args.benchmark)
