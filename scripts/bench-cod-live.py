#!/usr/bin/env -S uv run --script
"""Measure cod dispatch with a real, isolated VS Code instance. Never uses user windows."""
# ruff: noqa: S101, S603
from __future__ import annotations

import contextlib
import json
import os
import shlex
import signal
import statistics
import subprocess
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlparse

if TYPE_CHECKING:
    from collections.abc import Iterator
    from types import FrameType

ROOT = Path(__file__).resolve().parents[1]
CODE = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")


def run(*args: str | Path, **kwargs: object) -> subprocess.CompletedProcess[str]:
    """Bound each foreground process."""
    return subprocess.run(args, capture_output=True, text=True, check=True, timeout=20, **kwargs)


def owned_processes(user_data: Path) -> list[int]:
    """Find only the separate main process with our unique profile path."""
    processes = run("/bin/ps", "-axo", "pid=,args=").stdout.splitlines()
    return [int(line.strip().split(None, 1)[0]) for line in processes
            if "Visual Studio Code.app/Contents/MacOS/Code" in line and str(user_data) in line]


@contextlib.contextmanager
def cleanup_on_cancel() -> Iterator[None]:
    """Unwind on SIGTERM so app and directory cleanup still run."""
    def cancel(signum: int, _frame: FrameType | None) -> None:
        # A second cancellation must not interrupt the cleanup in progress.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SystemExit(128 + signum)

    previous = signal.signal(signal.SIGTERM, cancel)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def wait_for_exit(user_data: Path, timeout: float) -> list[int]:
    """Wait for the isolated main process to disappear, with a deadline."""
    deadline = time.monotonic() + timeout
    while remaining := owned_processes(user_data):
        if time.monotonic() >= deadline:
            return remaining
        time.sleep(0.1)
    return []


def stop_instance(user_data: Path) -> None:
    """Await both normal shutdown and forced shutdown."""
    for pid in owned_processes(user_data):
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
    remaining = wait_for_exit(user_data, 10)
    for pid in remaining:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
    assert not wait_for_exit(user_data, 5), "The isolated VS Code process did not stop"


def main() -> None:  # noqa: PLR0915
    """Measure warm CLI dispatch, then stop the isolated instance."""
    assert CODE.is_file(), "VS Code's CLI was not found"
    with tempfile.TemporaryDirectory(prefix="cod-bench-", dir="/tmp") as directory:
        fixture = Path(directory).resolve()
        folder = fixture / "nested space ' quote"
        folder.mkdir()
        user_data = fixture / "user-data"
        (user_data / "User").mkdir(parents=True)
        (user_data / "User/settings.json").write_text(json.dumps({"security.workspace.trust.enabled": False}))
        binary = fixture / "bin"
        binary.mkdir()
        wrapper = binary / "code"
        wrapper.write_text("#!/bin/sh\nexec " + shlex.join([
            str(CODE), "--user-data-dir", str(user_data), "--disable-extensions",
            "--skip-add-to-recently-opened",
        ]) + ' "$@"\n')
        wrapper.chmod(0o755)
        baseline = fixture / "baseline.zsh"
        baseline.write_text(run("git", "-C", ROOT, "show", "HEAD:zsh/.zsh_config/funcs.zsh").stdout)
        env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]}
        samples: dict[str, list[float]] = {name: [] for name in ("direct code", "HEAD cod", "current cod", "cod PATH")}
        try:
            started = time.monotonic()
            run(wrapper, ".", cwd=folder, env=env)
            deadline = time.monotonic() + 30
            opened = False
            while time.monotonic() < deadline:
                for workspace in (user_data / "User/workspaceStorage").glob("*/workspace.json"):
                    try:
                        path = unquote(urlparse(json.loads(workspace.read_text()).get("folder", "")).path)
                    except (OSError, json.JSONDecodeError):
                        continue
                    opened = path == str(folder)
                    if opened:
                        break
                if opened:
                    break
                time.sleep(0.1)
            assert opened, "Isolated VS Code did not open the exact fixture directory"
            print(f"Isolated VS Code cold folder ready: {(time.monotonic() - started) * 1000:.1f} ms (one sample)")
            for round_number in range(5):
                names = list(samples)
                names = names[round_number % len(names):] + names[:round_number % len(names)]
                for name in names:
                    source = baseline if name == "HEAD cod" else ROOT / "zsh/.zsh_config/funcs.zsh"
                    command = 'source "$1"; command code .' if name == "direct code" else 'source "$1"; cod'
                    if name == "cod PATH":
                        command += ' "$2"'
                    started = time.monotonic()
                    run("/bin/zsh", "-f", "-c", command, "cod-bench", source, folder, cwd=folder, env=env)
                    samples[name].append((time.monotonic() - started) * 1000)
            for name, values in samples.items():
                print(f"{name}: median {statistics.median(values):.1f} ms, "
                      f"range {min(values):.1f}..{max(values):.1f}, n={len(values)}")
            print("PASS: real cod dispatch opened the exact directory in an isolated VS Code instance")
        finally:
            stop_instance(user_data)
    print("PASS: isolated VS Code instance stopped and temporary files removed")


if __name__ == "__main__":
    with cleanup_on_cancel():
        main()
