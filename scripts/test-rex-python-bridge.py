#!/usr/bin/env -S uv run --script
"""Pin bridge error propagation and repeated cleanup without app changes."""
from rex_test_driver import RexTestDriver


def main():
    driver = RexTestDriver(deadline_ms=30_000)
    try:
        host = driver.create(command=["/bin/sh", "-c", "sleep 20"], columns=60, rows=15)
        driver.close(host)
        try:
            driver.capture(host)
        except RuntimeError as error:
            assert "session_not_found" in str(error) or "session not found" in str(error).lower(), str(error)
        else:
            raise AssertionError("A removed session returned a successful capture")
        driver.stop()
        assert driver.process.returncode == 0
        assert driver.errors.closed
        driver.stop()
        assert driver.process.returncode == 0
        print("PASS Python bridge propagates missing-session failures and repeated stop is safe")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
