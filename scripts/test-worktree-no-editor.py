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
import threading
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
    """Keep orchestrator calls out of every lifecycle hook."""
    if isinstance(value, dict):
        for name, child in value.items():
            if name.startswith(("pre-", "post-")):
                assert not re.search(
                    r"\b(?:orca|herdr|herdr-wt-open|wt-herdr|herdr-app|hc)\b",
                    json.dumps(child),
                ), f"{name} must not call an orchestrator"
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
    assert set(config["post-start"]) == {"venv", "copy", "registry"}
    assert "post-switch" not in config, "Orchestrator opening belongs to explicit cop commands"
    check_hooks(config)
    assert set(config["pre-remove"]) == {"protect"}
    assert set(config["post-remove"]) == {"prune-empty-branch-dir"}
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
        (bin_dir / "orca").symlink_to(recorder)
        config_dir = home / ".config/worktrunk"
        config_dir.mkdir(parents=True)
        shutil.copyfile(source, config_dir / "config.toml")
        git_config = home / ".gitconfig"
        git_config.write_text("[user]\nname = Fixture\nemail = fixture@example.invalid\n")
        env = dict(os.environ)
        for key in (
            "WORKTRUNK_AGENT",
            "WORKTRUNK_NO_OPEN",
            "WORKTRUNK_CONFIG",
            "GIT_DIR",
            "GIT_WORK_TREE",
        ):
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

        def run(*args: str, ok: bool = True, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
            result = subprocess.run(
                args,
                cwd=cwd or repo,
                env=env,
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            if ok and result.returncode:
                message = f"{args[0]} failed ({result.returncode}): {result.stderr}"
                raise AssertionError(message)
            return result

        run("git", "init", "-q", "-b", "main")
        (repo / ".gitignore").write_text(".venv\n.env\n")
        run("git", "add", ".gitignore")
        run("git", "commit", "-q", "-m", "fixture")
        remote = home / "demo.git"
        run("git", "init", "--bare", "-q", "-b", "main", str(remote))
        run("git", "remote", "add", "origin", str(remote))
        run("git", "push", "-q", "-u", "origin", "main")
        (repo / ".venv").mkdir()
        (repo / ".env").write_text("FIXTURE_ONLY=1\n")
        registry = home / ".cache/wt/known-repos"

        def verify(branch: str) -> Path:
            path = home / "worktrees/local" / branch / "demo"
            wait_for(
                lambda: (path / ".venv").is_symlink() and (path / ".env").exists() and registry.exists(),
                f"setup hooks for {branch}",
            )
            assert (path / ".venv").resolve() == (repo / ".venv").resolve()
            assert (path / ".env").read_text() == "FIXTURE_ONLY=1\n"
            assert str(repo) in registry.read_text().splitlines()
            for name in ("AGENTS.md", "CLAUDE.md"):
                assert not (path.parent.parent / name).exists(), "Creation shared inherited instructions"
                assert not (path.parent / name).exists(), "Creation wrote branch-wide instructions"
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
        wt_path = home / "worktrees/local/wt-fixture/demo"
        valuable = wt_path / "uncommitted.txt"
        valuable.write_text("keep this work\n")
        refused = run(wt, "remove", "wt-fixture", "--foreground", "--yes", ok=False)
        assert refused.returncode != 0, "native wt removed dirty work without force"
        assert valuable.read_text() == "keep this work\n"
        valuable.unlink()
        committed = wt_path / "approved.txt"
        committed.write_text("preserve this commit\n")
        run("git", "-C", str(wt_path), "add", "approved.txt")
        run("git", "-C", str(wt_path), "commit", "-q", "-m", "fixture change")
        assert committed.exists()
        run("git", "-C", str(wt_path), "push", "-q", "origin", "HEAD:main")
        main_before = run("git", "rev-parse", "HEAD").stdout.strip()
        (repo / "parallel-main.txt").write_text("unrelated live work\n")
        remote_head = run("git", "-C", str(wt_path), "rev-parse", "HEAD").stdout.strip()
        run(
            wt,
            "switch",
            "--create",
            "remote-base-fixture",
            "--base",
            "origin/main",
            "--no-cd",
            "--yes",
            "--format",
            "json",
        )
        remote_path = home / "worktrees/local/remote-base-fixture/demo"
        assert run("git", "rev-parse", "HEAD").stdout.strip() == main_before
        assert (repo / "parallel-main.txt").read_text() == "unrelated live work\n"
        assert run("git", "-C", str(remote_path), "rev-parse", "HEAD").stdout.strip() == remote_head
        run(
            "zsh",
            "-f",
            "-c",
            'eval "$(command wt config shell init zsh)"; wt remove --no-delete-branch --yes',
            cwd=wt_path,
        )
        wait_for(lambda: not wt_path.parent.exists(), "default wt removal cleanup")
        run(cop, "remove", "cop-fixture", "--repo", str(repo), "--yes")
        wait_for(lambda: not (home / "worktrees/local/cop-fixture").exists(), "default cop removal cleanup")
        run(wt, "remove", "remote-base-fixture", "--no-delete-branch", "--foreground", "--yes")
        wait_for(lambda: not remote_path.parent.exists(), "remote-base removal cleanup")
        wait_for(lambda: not (home / "worktrees/local").exists(), "empty owner cleanup")
        assert (home / "worktrees").is_dir(), "Cleanup removed the managed root"
        # Model a hook that starts before background removal finishes.
        delayed_path = home / "worktrees/local/delayed fixture/demo"
        delayed_path.mkdir(parents=True)
        timer = threading.Timer(0.5, delayed_path.rmdir)
        timer.start()
        try:
            run(wt, "hook", "post-remove", "--foreground", "--yes", f"--worktree-path={delayed_path}")
        finally:
            timer.join()
        assert not delayed_path.parent.exists(), "Hook left an empty parent after delayed removal"
        shared_path = home / "worktrees/local/shared/demo"
        sibling = shared_path.parent / "other-repo"
        sibling.mkdir(parents=True)
        (sibling / "keep.txt").write_text("preserve other work\n")
        run(wt, "hook", "post-remove", "--foreground", "--yes", f"--worktree-path={shared_path}")
        assert (sibling / "keep.txt").read_text() == "preserve other work\n"
        retained = home / "worktrees/local/retained/demo"
        retained.mkdir(parents=True)
        (retained / "keep.txt").write_text("unfinished removal\n")
        run(wt, "hook", "post-remove", "--foreground", "--yes", f"--worktree-path={retained}")
        assert (retained / "keep.txt").read_text() == "unfinished removal\n"
        outside = home / "outside/checkout"
        outside.parent.mkdir()
        run(wt, "hook", "post-remove", "--foreground", "--yes", f"--worktree-path={outside}")
        assert outside.parent.exists(), "Cleanup escaped the managed worktree root"
        assert not calls.exists(), "An editor or orchestrator was launched"
        print("PASS: caller background removal, empty owner cleanup, delayed cleanup, and bounded unfinished removal")
        print("PASS: sibling work, outside paths, and the managed root are preserved")
        print("PASS: real wt and cop create/reuse without editor gates or editor calls")
        print("PASS: lifecycle hooks and real wt and cop removal do not call an orchestrator")
        print("PASS: protected branches and native dirty-work refusal remain without a publication gate")
        print("PASS: fetch-only creation preserves dirty primary and uses the explicit remote base")


if __name__ == "__main__":
    main()
