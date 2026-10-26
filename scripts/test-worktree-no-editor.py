#!/usr/bin/env -S uv run --script
"""Test real wt and coppice creation without opening an editor or touching live state."""
# ruff: noqa: S101, S603, PLR0915

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def wait_for(check, description: str) -> None:
    """Wait for a background hook, with a fixed timeout."""
    deadline = time.monotonic() + 20
    while not check():
        if time.monotonic() >= deadline:
            message = f"Timed out: {description}"
            raise AssertionError(message)
        time.sleep(0.1)


def check_hooks(value) -> None:
    """Keep orchestrator commands out of every maintained lifecycle hook."""
    if isinstance(value, dict):
        for name, child in value.items():
            if name.startswith(("pre-", "post-")):
                assert not re.search(r"\b(?:orca|herdr|herdr-wt-open)\b", json.dumps(child)), (
                    f"{name} must not call an orchestrator"
                )
            check_hooks(child)
    elif isinstance(value, list):
        for child in value:
            check_hooks(child)


def main() -> None:
    """Check creation and cleanup in a disposable home directory."""
    wt = shutil.which("wt")
    cop = shutil.which("cop")
    assert wt, "wt must be installed"
    assert cop, "cop must be installed"
    source = ROOT / "worktrunk/.config/worktrunk/config.toml"
    config = tomllib.loads(source.read_text())
    assert set(config["post-start"]) == {"venv", "copy", "registry", "agents-md"}
    assert "post-switch" not in config, "Orchestrator opening belongs to explicit cop commands"
    check_hooks(config)
    assert config["pre-remove"]["protect"]
    assert config["post-remove"]["prune-empty-branch-dir"]
    assert not any("code -n" in value for value in config["post-start"].values())

    with tempfile.TemporaryDirectory(prefix="worktree-no-editor-") as directory:
        home = Path(directory).resolve()
        bin_dir = home / "bin"
        bin_dir.mkdir()
        calls = home / "editor-calls"
        recorder = bin_dir / "code"
        recorder.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$EDITOR_CALLS"\nexit 99\n')
        recorder.chmod(0o755)
        config_dir = home / ".config/worktrunk"
        config_dir.mkdir(parents=True)
        shutil.copyfile(source, config_dir / "config.toml")
        git_config = home / ".gitconfig"
        git_config.write_text("[user]\nname = Fixture\nemail = fixture@example.invalid\n")
        env = dict(os.environ)
        for key in ("WORKTRUNK_AGENT", "WORKTRUNK_NO_OPEN", "WORKTRUNK_CONFIG", "GIT_DIR", "GIT_WORK_TREE",
                    "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"):
            env.pop(key, None)
        env.update(
            HOME=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_CACHE_HOME=str(home / ".cache"),
            GIT_CONFIG_GLOBAL=str(git_config),
            GIT_CONFIG_NOSYSTEM="1",
            EDITOR_CALLS=str(calls),
            PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
        )
        parent = home / "projects/group"
        repo = parent / "demo"
        repo.mkdir(parents=True)
        for name in ("AGENTS.md", "CLAUDE.md"):
            (parent / name).write_text("Fixture instructions.\n")

        def run(*args: str, ok: bool = True) -> subprocess.CompletedProcess[str]:
            result = subprocess.run(args, cwd=repo, env=env, capture_output=True, text=True, timeout=45, check=False)
            if ok and result.returncode:
                message = f"{args[0]} failed ({result.returncode}): {result.stderr}"
                raise AssertionError(message)
            return result

        run("git", "init", "-q", "-b", "main")
        (repo / ".gitignore").write_text(".venv\n.env\n")
        run("git", "add", ".gitignore")
        run("git", "commit", "-q", "-m", "fixture")
        (repo / ".venv").mkdir()
        (repo / ".env").write_text("FIXTURE_ONLY=1\n")
        registry = home / ".cache/wt/known-repos"

        def verify(branch: str) -> Path:
            path = home / "worktrees/local" / branch / "demo"
            wait_for(
                lambda: (path / ".venv").is_symlink()
                and (path / ".env").exists()
                and registry.exists()
                and (path.parent.parent / "AGENTS.md").is_symlink()
                and (path.parent.parent / "CLAUDE.md").is_symlink(),
                f"setup hooks for {branch}",
            )
            assert (path / ".venv").resolve() == (repo / ".venv").resolve()
            assert (path / ".env").read_text() == "FIXTURE_ONLY=1\n"
            assert str(repo) in registry.read_text().splitlines()
            assert (path.parent.parent / "AGENTS.md").resolve() == parent / "AGENTS.md"
            assert not calls.exists(), "Worktree creation launched an editor"
            return path

        result = json.loads(run(wt, "switch", "--create", "wt-fixture", "--no-cd", "--yes", "--format", "json").stdout)
        assert Path(result["path"]).resolve() == verify("wt-fixture")
        run(wt, "switch", "wt-fixture", "--no-cd", "--yes", "--format", "json")
        run(cop, "new", str(repo), "--branch", "cop-fixture", "--yes")
        verify("cop-fixture")
        run(cop, "new", str(repo), "--branch", "cop-fixture", "--yes")
        listing = json.loads(run(wt, "list", "--format", "json").stdout)
        items = listing["items"] if isinstance(listing, dict) else listing
        assert {item["branch"] for item in items} == {"main", "wt-fixture", "cop-fixture"}
        protected = run(wt, "remove", "main", "--foreground", "--yes", ok=False)
        assert protected.returncode != 0
        assert repo.exists(), "Protected main checkout was removed"
        protection = run(wt, "hook", "pre-remove", "--yes", ok=False)
        assert protection.returncode != 0
        assert "refusing to remove protected branch" in protection.stderr
        for branch in ("wt-fixture", "cop-fixture"):
            run(wt, "remove", branch, "--foreground", "--yes")
            wait_for(lambda branch=branch: not (home / "worktrees/local" / branch).exists(), "empty branch cleanup")
        assert not calls.exists(), "An editor was launched"
        print("PASS: real wt and cop create/reuse without editor gates or editor calls")
        print("PASS: venv, copy-ignored, registry, inherited instructions, protected main, and removal cleanup")


if __name__ == "__main__":
    main()
