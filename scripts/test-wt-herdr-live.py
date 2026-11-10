#!/usr/bin/env -S uv run --script
"""Exercise source cop herdr in owned tmux and app spaces, then remove fixtures."""

import argparse
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args, env=None, timeout=15, check=True):
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[:1000]}")
    return result


def data(*args):
    return json.loads(run(*args).stdout)


def rpc(method, **params):
    request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    result = subprocess.run(["hc", "connect"], input=json.dumps(request) + "\n", text=True,
                            capture_output=True, timeout=10, check=True)
    response = next(json.loads(line) for line in result.stdout.splitlines() if json.loads(line).get("id") == 1)
    if response.get("error"):
        raise RuntimeError("Core RPC failed")
    return response["result"]


def wait_for(check, message, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coppice-source", type=Path, required=True)
    args = parser.parse_args()

    def interrupted(signum, frame):
        raise RuntimeError("Live test interrupted; cleaning owned resources")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    source = args.coppice_source.resolve(strict=True)
    helper = ROOT / "worktrunk/.local/bin/wt-herdr"
    original = data("herdr-app", "status")
    before = {t["address"]: (t["pid"], t["created_ms"]) for t in rpc("terminal.list")["terminals"]
              if t["state"] == "live"}
    session = f"ag-wt-herdr-{os.getpid()}"
    deadline = int(time.time()) + 240
    fixture_path = Path(tempfile.mkdtemp(prefix="wt-herdr-live-")).resolve()
    try:
        fixture = fixture_path
        repo = fixture / "fixture repo"
        repo.mkdir()
        bin_dir = fixture / "bin"
        bin_dir.mkdir()
        (bin_dir / "wt-herdr").symlink_to(helper)
        pi_binary = shutil.which("pi")
        if not pi_binary:
            raise RuntimeError("Pi is not installed")
        pi_shim = bin_dir / "pi"
        pi_shim.write_text("#!/bin/sh\nexec " + shlex.quote(pi_binary) + ' --no-session --no-extensions "$@"\n')
        pi_shim.chmod(0o755)
        shim = bin_dir / "cop"
        shim.write_text("#!/bin/sh\nexec env PYTHONPATH=" + shlex.quote(str(source / "src"))
                        + " uv run --directory " + shlex.quote(str(source)) + " --no-sync cop \"$@\"\n")
        shim.chmod(0o755)
        config = fixture / "wt.toml"
        config.write_text("worktree-path = " + json.dumps(str(fixture / "trees/{{ branch }}")) + "\n")
        wt_shim = bin_dir / "wt"
        wt_binary = run("/bin/zsh", "-f", "-c", "command -v wt").stdout.strip()
        wt_shim.write_text("#!/bin/sh\nexec " + shlex.quote(wt_binary)
                           + " --config " + shlex.quote(str(config)) + ' "$@"\n')
        wt_shim.chmod(0o755)
        env = dict(os.environ)
        env.pop("WORKTRUNK_AGENT", None)
        env.update(PATH=str(bin_dir) + os.pathsep + env["PATH"], WORKTRUNK_CONFIG=str(config),
                   XDG_CACHE_HOME=str(fixture / "cache"), GIT_CONFIG_NOSYSTEM="1")
        run("git", "-C", str(repo), "init", "-q", "-b", "main", env=env)
        run("git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "--allow-empty", "-q", "-m", "fixture", env=env)
        owned_terminals = set()
        owned_spaces = set()
        confirm_mod = Path.home() / ".config/herdr-app/mods" / f"ag-wt-herdr-close-{os.getpid()}"
        confirm_mod_created = False
        try:
            run("tmux", "new-session", "-d", "-s", session, "-x", "140", "-y", "38", "/bin/zsh -f")
            run(str(Path.home() / ".local/bin/reap-strays"), "--register-tmux", session,
                "--owner", str(os.getpid()), "--deadline", str(deadline))
            for index, branch in enumerate(["topic", "topic", "plain", "direct"]):
                result = fixture / f"result-{index}"
                exit_file = fixture / f"exit-{index}"
                pwd_file = fixture / f"pwd-{index}"
                if branch == "direct":
                    command = f"wt -C {shlex.quote(str(repo))} switch --create direct --no-cd --yes --format json"
                else:
                    command = (f"cop {'new' if branch == 'plain' else 'herdr'} {shlex.quote(str(repo))} "
                               f"--branch {branch} --base main --yes")
                command_env = {k: env[k] for k in ("PATH", "WORKTRUNK_CONFIG", "XDG_CACHE_HOME", "GIT_CONFIG_NOSYSTEM")}
                exports = " ".join(shlex.quote(f"{k}={v}") for k, v in command_env.items())
                prefix = "unset WORKTRUNK_AGENT; export " + exports + '; eval "$(command cop shell init zsh)"; '
                shell = (prefix + command + " >" + shlex.quote(str(result))
                         + " 2>&1; result_code=$?; pwd >" + shlex.quote(str(pwd_file))
                         + "; printf '%s' $result_code >" + shlex.quote(str(exit_file)))
                run("tmux", "send-keys", "-t", session, "-l", shell)
                run("tmux", "send-keys", "-t", session, "Enter")
                end = min(time.monotonic() + 110, time.monotonic() + max(1, deadline - time.time()))
                while not exit_file.exists() and time.monotonic() < end:
                    time.sleep(0.3)
                if not exit_file.exists():
                    raise RuntimeError("Live command deadline reached")
                if exit_file.read_text() != "0":
                    raise RuntimeError(result.read_text()[-2500:])
                path = fixture / "trees" / branch
                if branch != "direct":
                    assert pwd_file.read_text().strip() == str(path), "Calling shell did not enter the checkout"
                spaces = data("herdr-app", "ls")["spaces"]
                rendered = fixture / f"screen-{index}"
                rendered.write_text(run("tmux", "capture-pane", "-t", session, "-p").stdout)
                assert run("tmux", "display-message", "-t", session, "-p", "#{pane_dead}").stdout.strip() != "1"
                test_spaces = [s for s in spaces if s.get("folder", "").startswith(str(fixture))]
                owned_spaces.update(s["id"] for s in test_spaces)
                for space in test_spaces:
                    for tab in space["tabs"]:
                        owned_terminals.update(t["terminal"] for t in tab.get("terminals", []))
                assert len(test_spaces) == 2, "Expected exactly one Files parent and one topic child"
                assert len(owned_terminals) == 1, "Create/reuse or ordinary wt launched an extra terminal"
                child = next(s for s in test_spaces if s["folder"] == str(fixture / "trees/topic"))
                assert child["name"] == "topic"
                terminal = next(iter(owned_terminals))
                fact = rpc("terminal.get", terminal=terminal)
                assert fact["foreground"]["cwd"] == str(fixture / "trees/topic")
                assert fact["status"]["app"] == "pi" and fact["reported"] is True
                if index < 2:
                    selected = data("herdr-app", "status")
                    assert selected["space"] == child["id"] and selected["agent"] == terminal
            print("PASS: source cop herdr creates, groups, reuses and focuses one real Pi; shell cd path matches")
            print("PASS: cop new and direct wt add no app spaces or terminals")
            placement = next((s, t, p) for s in data("herdr-app", "ls")["spaces"]
                             for t in s["tabs"] for p in t.get("terminals", []) if p["terminal"] == terminal)
            initial = rpc("terminal.get", terminal=terminal)
            assert Path(initial["argv"][0]).name in {"sh", "bash", "zsh", "fish"}, "Pi has no surviving shell"
            run("hc", "keys", terminal, "x", "ctrl+c")
            cleared = rpc("terminal.get", terminal=terminal)
            assert cleared["state"] == "live", "First Ctrl+C ended the terminal"
            assert cleared["foreground"]["pid"] != initial["pid"], "First Ctrl+C exited Pi instead of clearing input"
            assert cleared["status"]["app"] == "pi", "First Ctrl+C lost Pi"
            run("hc", "keys", terminal, "ctrl+c", "ctrl+c")

            def returned_shell():
                current = rpc("terminal.get", terminal=terminal)
                foreground = current.get("foreground") or {}
                return current if current.get("state") == "live" and foreground.get("pid") == initial["pid"] else None

            returned = wait_for(returned_shell, "Pi did not return to its original shell")
            assert Path(returned["foreground"]["argv"][0]).name in {"sh", "bash", "zsh", "fish"}
            present = next((s, t, p) for s in data("herdr-app", "ls")["spaces"]
                           for t in s["tabs"] for p in t.get("terminals", []) if p["terminal"] == terminal)
            assert (present[0]["id"], present[1]["id"], present[2]["pane"]) == (
                placement[0]["id"], placement[1]["id"], placement[2]["pane"]), "Pi exit removed or replaced its tab"
            wait_for(lambda: data("hc", "read", terminal, "--json")["text"].rstrip().endswith(("$", "%", "#", ">")),
                     "Returned shell prompt is not ready", timeout=30)
            # Core send adds an agent envelope after Pi reports status. Shells need literal keys.
            marker = "wtherdrshellready"
            run("hc", "keys", terminal, *list("echo"), "space", *list(marker), "enter")
            try:
                wait_for(lambda: any(line.strip() == marker for line in
                                     data("hc", "read", terminal, "--json")["text"].splitlines()),
                         "Returned shell did not accept input")
            except RuntimeError:
                print("Returned shell screen:", data("hc", "read", terminal, "--json")["text"][-2500:])
                raise
            print("PASS: Ctrl+C clears Pi input; double Ctrl+C exits to a usable shell in the same terminal, pane and tab")
            for extra in present[0]["tabs"]:
                if extra["id"] != present[1]["id"]:
                    assert not extra.get("terminals"), "Refusing to close another terminal tab"
                    run("herdr-app", "do", "tab.close", json.dumps({"id": extra["id"], "confirmed": True}))
            assert not data("herdr-app", "status")["overlays"], "Unexpected overlay before confirmation check"
            confirm_mod.mkdir()
            confirm_mod_created = True
            (confirm_mod / "mod.json").write_text(json.dumps({"place": "none"}))
            (confirm_mod / "main.js").write_text(
                'import {View,div} from "gpui-kit";\n'
                'import {spaces,props,run,closeOverlay} from "herdr";\n'
                'export default class CloseTest extends View { init() {\n'
                'const id=' + json.dumps(present[1]["id"]) + ';\n'
                'if(spaces().some(s=>s.tabs.length===1&&s.tabs[0].id===id)) run("tab.close",{id});\n'
                'const overlay=props()?.overlay; if(overlay) closeOverlay(overlay);\n'
                '} render() { return div().child("Disposable confirmation test"); } }\n')
            run("herdr-app", "check", str(confirm_mod))
            run("herdr-app", "do", "mod.open", "--name", confirm_mod.name)
            wait_for(lambda: data("herdr-app", "status")["overlays"] == ["confirm"], "Last-tab close did not ask")
            screenshot = Path("/tmp") / f"wt-herdr-close-confirm-{os.getpid()}.png"
            run("herdr-app", "shot", str(screenshot))
            assert rpc("terminal.get", terminal=terminal)["state"] == "live"
            assert any(s["id"] == present[0]["id"] for s in data("herdr-app", "ls")["spaces"])
            run("herdr-app", "do", "overlay.close")
            print(f"PASS: explicit last-tab close asks before ending the returned shell; screenshot: {screenshot}")
        finally:
            selected = data("herdr-app", "status")
            if selected.get("space") in owned_spaces and selected.get("overlays") == ["confirm"]:
                run("herdr-app", "do", "overlay.close")
            if confirm_mod_created:
                shutil.rmtree(confirm_mod)
            run("tmux", "kill-session", "-t", session, check=False)
            # Discover task-owned resources even if a launch receipt was lost.
            for space in data("herdr-app", "ls")["spaces"]:
                if space.get("folder", "").startswith(str(fixture)):
                    owned_spaces.add(space["id"])
                    for tab in space["tabs"]:
                        owned_terminals.update(t["terminal"] for t in tab.get("terminals", []))
            for address in owned_terminals:
                fact = rpc("terminal.get", terminal=address)
                if fact.get("state") == "live":
                    cwd = (fact.get("foreground") or {}).get("cwd", "")
                    assert cwd.startswith(str(fixture)), "Refusing to kill a terminal outside this fixture"
                    run("hc", "kill", address)
                run("hc", "rm", address)
            for sid in owned_spaces:
                run("herdr-app", "do", "space.close", json.dumps({"id": sid, "confirmed": True}), check=False)
            for branch in ["topic", "plain", "direct"]:
                path = fixture / "trees" / branch
                if path.exists():
                    dirty = run("git", "-C", str(path), "status", "--porcelain").stdout.strip()
                    assert not dirty, "Fixture worktree has unexpected changes"
                    run("wt", "-C", str(repo), "remove", branch, "--no-delete-branch", "--foreground", "--yes", env=env)
            if original.get("focused_pane"):
                run("herdr-app", "do", "pane.focus", json.dumps({"pane": original["focused_pane"]}), check=False)
            current = {t["address"]: (t["pid"], t["created_ms"]) for t in rpc("terminal.list")["terminals"]
                       if t["state"] == "live"}
            assert current == before, "Live terminal identities changed after cleanup"
            assert not data("herdr-app", "status")["errors"]
            assert run("tmux", "has-session", "-t", session, check=False).returncode != 0
            print("PASS: owned tmux, app terminals, spaces and fixture checkouts removed; existing terminals preserved")
    finally:
        # Keep a failed fixture when valuable files or worktree cleanup remain.
        if not (fixture_path / "trees").exists() or not list((fixture_path / "trees").iterdir()):
            shutil.rmtree(fixture_path)
        else:
            print(f"Fixture preserved for cleanup: {fixture_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
