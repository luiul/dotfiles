"""Use the shared private Rex driver without repeating its lifecycle in Python."""
from __future__ import annotations

import json
import selectors
import subprocess
import tempfile
from pathlib import Path


class RexTestDriver:
    def __init__(self, deadline_ms: int = 480_000):
        # Avoid a captured stderr pipe blocking a long-lived service. Keep its
        # diagnostics in a private file and include them only after failure.
        self.errors = tempfile.TemporaryFile(mode="w+t")
        self.process = subprocess.Popen(
            ["node", str(Path(__file__).with_name("rex-test-service.mjs")), str(deadline_ms)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors,
            text=True, bufsize=1,
        )
        self.sequence = 0
        self.stopped = False

    def call(self, operation: str, **args):
        self.sequence += 1
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(json.dumps({"id": self.sequence, "operation": operation, "args": args}) + "\n")
        self.process.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=45):
                raise TimeoutError(f"Rex fixture operation timed out: {operation}")
        line = self.process.stdout.readline()
        if not line:
            self.errors.seek(0)
            detail = self.errors.read()[-3000:]
            raise RuntimeError(f"Rex fixture service exited: {detail}")
        reply = json.loads(line)
        assert reply["id"] == self.sequence
        if reply.get("error"):
            raise RuntimeError(reply["error"])
        return reply["result"]

    def create(self, **args):
        return self.call("create", **args)

    def capture(self, host, **options):
        return self.call("capture", host=host, options=options)

    def text(self, host, data: str):
        return self.call("text", host=host, data=data)

    def key(self, host, key: str):
        return self.call("key", host=host, key=key)

    def close(self, host):
        return self.call("close", host=host)

    def stop(self):
        if self.stopped:
            return
        try:
            if self.process.poll() is None:
                self.call("stop")
        finally:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            if self.process.stdout:
                self.process.stdout.close()
            code = self.process.returncode
            self.errors.seek(0)
            detail = self.errors.read()[-3000:]
            self.errors.close()
            self.stopped = True
            if code:
                raise RuntimeError(f"Rex fixture service cleanup failed ({code}): {detail}")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.stop()
