#!/usr/bin/env -S uv run --script
"""Check benchmark cancellation and forced-shutdown cleanup without opening apps."""
# ruff: noqa: S101, S603
from __future__ import annotations

import importlib.util
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import call, patch

SCRIPT = Path(__file__).with_name("bench-cod-live.py")
spec = importlib.util.spec_from_file_location("benchmark", SCRIPT)
assert spec is not None
assert spec.loader is not None
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class CleanupTests(unittest.TestCase):
    """Pin cancellation and asynchronous shutdown handling."""

    def test_forced_shutdown_waits(self) -> None:
        """A process may remain visible briefly after SIGKILL."""
        with patch.object(benchmark, "owned_processes", side_effect=[[321], [321], [321], []]), \
                patch.object(benchmark.time, "monotonic", side_effect=[0, 11, 11, 12]), \
                patch.object(benchmark.time, "sleep") as sleep, patch.object(benchmark.os, "kill") as kill:
            benchmark.stop_instance(Path("private-test-profile"))
        assert kill.call_args_list == [call(321, signal.SIGTERM), call(321, signal.SIGKILL)]
        sleep.assert_called_once_with(0.1)

    def test_sigterm_unwinds(self) -> None:
        """A real SIGTERM must execute finally and remove the fixture directory."""
        code = """import importlib.util, sys, tempfile, time
from pathlib import Path
spec = importlib.util.spec_from_file_location('benchmark', sys.argv[1])
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
root = Path(sys.argv[2])
with b.cleanup_on_cancel(), tempfile.TemporaryDirectory(dir=root) as folder:
    try:
        (root / 'ready').write_text(folder)
        time.sleep(30)
    finally:
        (root / 'cleaned').write_text('yes')
"""
        with tempfile.TemporaryDirectory(prefix="test-launch-cancel-") as directory:
            root = Path(directory)
            uv = shutil.which("uv")
            assert uv is not None
            process = subprocess.Popen([uv, "run", "--no-project", "python", "-c", code, str(SCRIPT), directory],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 10
                while not (root / "ready").exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                assert (root / "ready").exists(), "The cancellation fixture did not start"
                folder = Path((root / "ready").read_text())
                os.killpg(process.pid, signal.SIGTERM)
                output, error = process.communicate(timeout=10)
                assert (root / "cleaned").read_text() == "yes", (output, error)
                assert not folder.exists(), "Temporary directory survived cancellation"
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
