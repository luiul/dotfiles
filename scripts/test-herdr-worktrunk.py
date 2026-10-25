#!/usr/bin/env -S uv run --script
"""Exercise installed Herdr and Worktrunk in an isolated named session."""
# ruff: noqa: S101, S603, PLR0915, C901

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SESSION = os.environ["HERDR_WT_TEST_SESSION"]
SOCKET = Path.home() / f".config/herdr/sessions/{SESSION}/herdr.sock"
PICKER_PANE_COUNT = 2


def main() -> None:
    """Check picker, external creation, grouping, reuse, and safe removal."""
    herdr = shutil.which("herdr")
    wt = shutil.which("wt")
    cop = shutil.which("cop")
    assert herdr
    assert wt
    assert cop
    inherited = dict(os.environ)
    with tempfile.TemporaryDirectory(prefix="herdr-wt-smoke-", dir="/tmp") as directory:
        home = Path(directory).resolve()
        repo = home / "projects/demo"
        repo.mkdir(parents=True)
        bin_dir = home / "bin"
        bin_dir.mkdir()
        config_dir = home / ".config/worktrunk"
        config_dir.mkdir(parents=True)
        shutil.copy(ROOT / "worktrunk/.config/worktrunk/config.toml", config_dir / "config.toml")
        editor_calls = home / "editor-calls"
        (bin_dir / "code").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$EDITOR_CALLS"\nexit 99\n')
        (bin_dir / "fzf").write_text('#!/bin/sh\ncat >/dev/null\nprintf "enter\\n%s\\n" "plugin-fixture"\n')
        for name in ("code", "fzf"):
            (bin_dir / name).chmod(0o755)
        env = dict(inherited)
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / ".cache"),
                   PATH=str(bin_dir) + os.pathsep + inherited["PATH"], HERDR_ENV="1", HERDR_SOCKET_PATH=str(SOCKET),
                   EDITOR_CALLS=str(editor_calls), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(home / ".gitconfig"))
        for key in ("HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "HERDR_TAB_ID"):
            env.pop(key, None)
        (home / ".gitconfig").write_text("[user]\nname=Fixture\nemail=fixture@example.invalid\n")

        def run(*args: str, cwd=repo, check=True, timeout=40):
            result = subprocess.run(
                args, cwd=cwd, env=env, capture_output=True, text=True, check=False, timeout=timeout,
            )
            if check and result.returncode:
                message = f"{args}: {result.stderr}"
                raise AssertionError(message)
            return result

        def api(*args: str):
            return json.loads(run(herdr, *args).stdout)["result"]

        run("git", "init", "-q", "-b", "main")
        (repo / ".gitignore").write_text(".venv\n.env\n")
        run("git", "add", ".gitignore")
        run("git", "commit", "-q", "-m", "fixture")
        (repo / ".venv").mkdir()
        (repo / ".env").write_text("FIXTURE_ONLY=1\n")
        parent = api("workspace", "create", "--cwd", str(repo), "--label", "herdr-smoke", "--no-focus")
        wid = parent["workspace"]["workspace_id"]
        env["HERDR_WORKSPACE_ID"] = wid
        env["HERDR_PANE_ID"] = parent["root_pane"]["pane_id"]
        env["HERDR_TAB_ID"] = parent["tab"]["tab_id"]
        plugin = api("plugin", "list", "--plugin", "worktrunk", "--json")["plugins"][0]
        plugin_root = Path(plugin["plugin_root"])
        env["HERDR_PLUGIN_ROOT"] = str(plugin_root)
        env["HERDR_PLUGIN_CONFIG_DIR"] = str(ROOT / "herdr/.config/herdr/plugins/config/worktrunk")

        def worktrees():
            return api("worktree", "list", "--cwd", str(repo))["worktrees"]

        def wait_open(branch: str):
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                row = next((item for item in worktrees() if item["branch"] == branch), None)
                if row and row.get("open_workspace_id"):
                    return row
                time.sleep(0.1)
            message = f"No open sidebar workspace for {branch}"
            raise AssertionError(message)

        tmux = shutil.which("tmux")
        assert tmux
        client = f"ag-herdr-client-{os.getpid()}"
        client_log = home / "client.log"
        command = "env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID "
        command += "HOME=" + shlex.quote(str(Path.home())) + " XDG_CONFIG_HOME="
        command += shlex.quote(str(Path.home() / ".config")) + " "
        command += shlex.quote(herdr) + " --session " + shlex.quote(SESSION)
        command += " 2>" + shlex.quote(str(client_log)) + "; sleep 60"
        run(tmux, "new-session", "-d", "-s", client, "-c", str(repo), "-x", "140", "-y", "40", command)
        try:
            # Drive the actual configured keybinding, then cancel the real fzf picker.
            time.sleep(1)
            run(tmux, "send-keys", "-t", client, "C-b", "G")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                panes = api("pane", "list", "--workspace", wid)["panes"]
                if len(panes) == PICKER_PANE_COUNT:
                    break
                time.sleep(0.1)
            assert len(panes) == PICKER_PANE_COUNT, (
                "Configured key did not open the plugin picker: " + client_log.read_text()
            )
            time.sleep(1)
            run(tmux, "send-keys", "-t", client, "Escape")
            print("PASS: actual Ctrl+B, Shift+G binding opens the plugin picker")
            # Run the installed unmodified picker with deterministic fzf output.
            run("bash", str(plugin_root / "picker.sh"), "--create-base=default")
            row = wait_open("plugin-fixture")
            workspace = api("workspace", "get", row["open_workspace_id"])["workspace"]
            assert workspace["worktree"]["is_linked_worktree"] is True
            assert Path(workspace["worktree"]["repo_root"]).resolve() == repo
            assert Path(workspace["worktree"]["checkout_path"]).resolve() == Path(row["path"])
            assert Path(row["path"]).parent.name == "plugin-fixture"
            setup_deadline = time.monotonic() + 20
            while not (Path(row["path"]) / ".env").exists() and time.monotonic() < setup_deadline:
                time.sleep(0.1)
            assert (Path(row["path"]) / ".venv").is_symlink()
            assert (Path(row["path"]) / ".env").read_text() == "FIXTURE_ONLY=1\n"
            # Reuse must not duplicate an already-open workspace.
            run("bash", str(plugin_root / "picker.sh"), "--create-base=default")
            assert wait_open("plugin-fixture")["open_workspace_id"] == row["open_workspace_id"]
            api("workspace", "rename", row["open_workspace_id"], "custom-name")
            run(str(ROOT / "herdr/.local/bin/herdr-wt-open"), str(repo), row["path"])
            assert next(item for item in api("workspace", "list")["workspaces"]
                        if item["workspace_id"] == row["open_workspace_id"])["label"] == "custom-name"
            before_focus = next(
                item["workspace_id"] for item in api("workspace", "list")["workspaces"] if item["focused"]
            )
            run(cop, "new", str(repo), "--branch", "cop-fixture", "--yes")
            wait_open("cop-fixture")
            run(wt, "switch", "--create", "wt-fixture", "--no-cd", "--yes", "--format", "json")
            wait_open("wt-fixture")
            # Switching to a checkout created outside Herdr must register it too.
            env.pop("HERDR_ENV")
            run(wt, "switch", "--create", "external-fixture", "--no-cd", "--yes", "--format", "json")
            external = next(item for item in worktrees() if item["branch"] == "external-fixture")
            assert not external.get("open_workspace_id")
            env["HERDR_ENV"] = "1"
            run(cop, "new", str(repo), "--branch", "external-fixture", "--yes")
            wait_open("external-fixture")
            after_focus = next(
                item["workspace_id"] for item in api("workspace", "list")["workspaces"] if item["focused"]
            )
            assert before_focus == after_focus, "External creation stole focus"
            assert not editor_calls.exists(), "An editor was launched"
            print("PASS: installed picker creates/reuses via wt; cop and agent wt register without focus changes")
            print("PASS: configured paths, setup hooks, and custom labels remain intact; zero editor calls")
            time.sleep(0.5)
            screen = run(tmux, "capture-pane", "-t", client, "-p").stdout
            assert "custom-name" in screen
            assert "cop-fixture" in screen
            assert "wt-fixture" in screen
            print("PASS: linked worktree names render in the real Herdr sidebar")
            # Exercise the plugin's removal path on a clean fixture via real wt and Herdr.
            (bin_dir / "fzf").write_text('#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "plugin-fixture"\n')
            run("bash", str(plugin_root / "remove.sh"))
            assert not any(item["branch"] == "plugin-fixture" for item in worktrees())
            assert not any(item["workspace_id"] == row["open_workspace_id"]
                           for item in api("workspace", "list")["workspaces"])
            print("PASS: real plugin removal uses wt and closes only the removed test workspace")
            # Exercise the exact registration hook with spaces in both path arguments.
            # Other hooks have their own established quoting conventions; isolate this hook.
            spaced_repo = home / "space projects" / "space repo"
            spaced_repo.mkdir(parents=True)
            run("git", "init", "-q", "-b", "main", cwd=spaced_repo)
            run("git", "commit", "-q", "--allow-empty", "-m", "fixture", cwd=spaced_repo)
            spaced_config = home / "spaced.toml"
            hooks = tomllib.loads((config_dir / "config.toml").read_text())["post-switch"]
            spaced_config.write_text(
                'worktree-path = "../space checkout"\n[post-switch]\nherdr = ' + json.dumps(hooks["herdr"]) + "\n",
            )
            run(wt, "--config", str(spaced_config), "switch", "--create", "spaced-fixture",
                "--no-cd", "--yes", "--format", "json", cwd=spaced_repo)
            deadline = time.monotonic() + 20
            spaced_id = None
            spaced_parent_id = None
            while time.monotonic() < deadline:
                spaced_result = api("worktree", "list", "--cwd", str(spaced_repo))
                spaced_parent_id = spaced_result["source"].get("source_workspace_id")
                spaced_row = next(item for item in spaced_result["worktrees"] if item["branch"] == "spaced-fixture")
                spaced_id = spaced_row.get("open_workspace_id")
                if spaced_id:
                    break
                time.sleep(0.1)
            assert spaced_id, "Space-containing paths failed sidebar registration"
            api("workspace", "close", spaced_id)
            if spaced_parent_id:
                api("workspace", "close", spaced_parent_id)
            run(wt, "--config", str(spaced_config), "remove", "spaced-fixture", "--foreground", "--yes",
                cwd=spaced_repo)
            print("PASS: exact wt registration hook handles repo and checkout paths containing spaces")
            for branch in ("cop-fixture", "wt-fixture", "external-fixture"):
                target = wait_open(branch)
                # Close only owned test shells before removing their checkout.
                api("workspace", "close", target["open_workspace_id"])
                run(wt, "remove", branch, "--foreground", "--yes")
            api("workspace", "close", wid)
        finally:
            run(tmux, "kill-session", "-t", client, check=False)
            # Remove only the fixture's workspace group if a check failed.
            items = api("workspace", "list")["workspaces"]
            if any(item["workspace_id"] == wid for item in items):
                api("workspace", "close", wid, "--group")


if __name__ == "__main__":
    main()
