#!/usr/bin/env -S uv run --script
"""Exercise Worktrunk and source wt-herdr with Rex and real Herdr app spaces.

This live harness intentionally changes app spaces and focus when run.
"""

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

from rex_test_driver import RexTestDriver

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
    parser.parse_args()

    def interrupted(signum, frame):
        raise RuntimeError("Live test interrupted; cleaning owned resources")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    helper = ROOT / "worktrunk/.local/bin/wt-herdr"
    original = data("herdr-app", "status")
    before = {t["address"]: (t["pid"], t["created_ms"]) for t in rpc("terminal.list")["terminals"]
              if t["state"] == "live"}
    driver = None
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
                   WT_HERDR_STATE_HOME=str(fixture / "state"),
                   XDG_CACHE_HOME=str(fixture / "cache"), GIT_CONFIG_NOSYSTEM="1")
        run("git", "-C", str(repo), "init", "-q", "-b", "main", env=env)
        run("git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "--allow-empty", "-q", "-m", "fixture", env=env)
        owned_terminals = set()
        owned_spaces = set()
        confirm_mod = Path.home() / ".config/herdr-app/mods" / f"ag-wt-herdr-close-{os.getpid()}"
        confirm_mod_created = False
        caller = None
        try:
            # A real caller inside Herdr can change checkout after opening the Pi terminal.
            caller_doc = rpc("doc.get", name="herdr-app")
            caller_space = {
                "id": "sp-test-" + str(os.getpid()), "name": "Fixture caller", "folder": str(repo),
                "tabs": [{"id": "tb-test-" + str(os.getpid()), "name": "Files", "root": {
                    "id": "tb-test-" + str(os.getpid()), "type": "row", "children": [{
                        "id": "p-test-" + str(os.getpid()), "type": "block",
                        "content": {"mod": "files", "props": {}}
                    }]
                }}]
            }
            caller_doc["value"]["spaces"].append(caller_space)
            rpc("doc.set", name="herdr-app", value=caller_doc["value"], version=caller_doc["version"])
            owned_spaces.add(caller_space["id"])
            files_tab_id = caller_space["tabs"][0]["id"]
            shell_tab_id = "tb-shell-" + str(os.getpid())
            caller_receipt = data("hc", "run", "--bg", "--keep", "--no-parent", "--no-notify", "--cwd", str(repo),
                                  "--label", "herdr.space=" + caller_space["id"],
                                  "--label", "herdr.tab=" + shell_tab_id, "--", "/bin/zsh", "-f")
            caller = caller_receipt["address"]
            owned_terminals.add(caller)

            def caller_tabs_visible():
                spaces = data("herdr-app", "ls")["spaces"]
                matching = [s for s in spaces if s["id"] == caller_space["id"]]
                if len(matching) != 1:
                    return None
                tabs = {t["id"]: t for t in matching[0]["tabs"]}
                if files_tab_id not in tabs or shell_tab_id not in tabs:
                    return None
                if tabs[files_tab_id].get("terminals"):
                    return None
                shell_terminals = tabs[shell_tab_id].get("terminals", [])
                if len(shell_terminals) != 1 or shell_terminals[0]["terminal"] != caller:
                    return None
                return matching[0]

            wait_for(caller_tabs_visible, "Distinct Files and caller shell tabs did not appear")
            initial_space = next(s for s in rpc("doc.get", name="herdr-app")["value"]["spaces"]
                                 if s["id"] == caller_space["id"])
            initial_files = next(t for t in initial_space["tabs"] if t["id"] == files_tab_id)
            assert initial_files == caller_space["tabs"][0], "Files tab changed during setup"
            files_bytes = json.dumps(initial_files, ensure_ascii=False).encode()
            assert initial_space["folder"] == str(repo), "Caller folder changed during setup"

            def initial_caller_ready():
                current = rpc("terminal.get", terminal=caller)
                foreground = current.get("foreground") or {}
                if (current.get("state") == "live" and current.get("pid") and current.get("argv")
                        and current.get("keep") is True and foreground.get("pid") and foreground.get("argv")
                        and foreground.get("cwd") == str(repo)):
                    return current
                return None

            original_caller = wait_for(initial_caller_ready, "Fixture caller identity is not ready")
            # Only the supplementary caller is private. Herdr still changes real app spaces and focus.
            driver = RexTestDriver(deadline_ms=max(1000, int((deadline - time.time()) * 1000)))
            host = driver.create(name=f"ag-wt-herdr-{os.getpid()}", command=["/bin/zsh", "-f"],
                                 env=env, cwd=str(repo), columns=140, rows=38)
            repo_arg = shlex.quote(str(repo))
            for index, branch in enumerate(["topic", "topic", "direct"]):
                path = fixture / "trees" / branch
                path_arg = shlex.quote(str(path))
                result = fixture / f"result-{index}"
                exit_file = fixture / f"exit-{index}"
                pwd_file = fixture / f"pwd-{index}"
                pwd_before_cd = fixture / f"pwd-before-cd-{index}"
                create = f"wt -C {repo_arg} switch --create {branch} --base main --no-cd --yes --format json"
                opening = f"wt-herdr open --repo {repo_arg} --path {path_arg}"
                if index == 0:
                    command = f"wt-herdr check --repo {repo_arg} && {create} && {opening}"
                else:
                    command = create if branch == "direct" else opening
                # Opening does not move the caller. Do that explicitly to exercise repair on the next open.
                command += f" && pwd >{shlex.quote(str(pwd_before_cd))}"
                if index == 0:
                    command += f" && cd {path_arg}"
                command_env = {k: env[k] for k in (
                    "PATH", "WORKTRUNK_CONFIG", "WT_HERDR_STATE_HOME", "XDG_CACHE_HOME", "GIT_CONFIG_NOSYSTEM",
                )}
                exports = " ".join(shlex.quote(f"{k}={v}") for k, v in command_env.items())
                prefix = "unset WORKTRUNK_AGENT; export " + exports + "; "
                shell = (prefix + "{ " + command + "; } >" + shlex.quote(str(result))
                         + " 2>&1; result_code=$?; pwd >" + shlex.quote(str(pwd_file))
                         + "; printf '%s' $result_code >" + shlex.quote(str(exit_file)))
                if index == 0:
                    run("hc", "send", caller, shell)
                else:
                    driver.text(host, shell)
                    driver.key(host, "enter")
                end = min(time.monotonic() + 110, time.monotonic() + max(1, deadline - time.time()))
                while not exit_file.exists() and time.monotonic() < end:
                    time.sleep(0.3)
                if not exit_file.exists():
                    raise RuntimeError("Live command deadline reached")
                if exit_file.read_text() != "0":
                    raise RuntimeError(result.read_text()[-2500:])
                expected_cwd = path if index == 0 else repo
                assert (path.is_dir(), pwd_before_cd.read_text().strip(), pwd_file.read_text().strip()) == (
                    True, str(repo), str(expected_cwd),
                ), "Missing checkout or unexpected caller directory"
                spaces = data("herdr-app", "ls")["spaces"]
                rendered = fixture / f"screen-{index}"
                rendered.write_text(driver.capture(host))
                assert not driver.call("process", host=host).get("last_exit"), "Rex caller shell exited"
                test_spaces = [s for s in spaces if s.get("folder", "").startswith(str(fixture))]
                owned_spaces.update(s["id"] for s in test_spaces)
                for space in test_spaces:
                    for tab in space["tabs"]:
                        owned_terminals.update(t["terminal"] for t in tab.get("terminals", []))
                assert len(test_spaces) == 3, "Expected one stable parent, caller conversation and topic conversation: " + repr([(s["name"], s["folder"], s["id"]) for s in test_spaces])
                assert len(owned_terminals) == 2, "Expected exactly the original shell and one Pi"
                fixture_terminals = set()
                for item in rpc("terminal.list", all=True)["terminals"]:
                    paths = (item.get("cwd"), (item.get("foreground") or {}).get("cwd"))
                    if item.get("state") == "live" and any(
                        path and Path(path).is_absolute() and Path(path).is_relative_to(fixture) for path in paths
                    ):
                        fixture_terminals.add(item["address"])
                assert fixture_terminals == owned_terminals, "Unexpected or unplaced fixture terminal"
                parent = next(s for s in test_spaces if s["name"] == "fixture repo")
                assert not any(t.get("terminals") for t in parent["tabs"]), "Repo parent gained a terminal"
                assert parent["folder"] == str(repo)
                child = next(s for s in test_spaces if s["name"] == "topic")
                terminal = next(t for t in owned_terminals if t != caller)
                def caller_in_topic():
                    current = rpc("terminal.get", terminal=caller)
                    foreground = current.get("foreground") or {}
                    return current if foreground.get("cwd") == str(fixture / "trees/topic") else None

                caller_fact = wait_for(caller_in_topic, "Herdr caller shell did not cd")
                fact = rpc("terminal.get", terminal=terminal)
                assert fact["foreground"]["cwd"] == str(fixture / "trees/topic")
                assert fact["status"]["app"] == "pi" and fact["reported"] is True
                layout = rpc("doc.get", name="herdr-app")["value"]
                source_space = next(s for s in layout["spaces"] if s["id"] == caller_space["id"])
                files = next(t for t in source_space["tabs"] if t["id"] == files_tab_id)
                assert json.dumps(files, ensure_ascii=False).encode() == files_bytes, "Original Files tab changed"
                assert source_space["folder"] == str(repo), "Original Files folder changed"
                caller_placements = [(s, t, p) for s in spaces for t in s["tabs"]
                                     for p in t.get("terminals", []) if p["terminal"] == caller]
                pi_placements = [(s, t, p) for s in spaces for t in s["tabs"]
                                 for p in t.get("terminals", []) if p["terminal"] == terminal]
                assert len(caller_placements) == len(pi_placements) == 1, "Terminal placement duplicated or missing"
                caller_placement = caller_placements[0]
                pi_placement = pi_placements[0]
                assert pi_placement[0]["id"] == child["id"], "Pi left the topic space"
                if index == 0:
                    assert caller_placement[0]["id"] == caller_space["id"], "Caller moved before shell drift"
                    assert caller_placement[1]["id"] == shell_tab_id
                    shell_tab = next(t for t in source_space["tabs"] if t["id"] == shell_tab_id)
                    shell_bytes = json.dumps(shell_tab, ensure_ascii=False).encode()
                    caller_pane = caller_placement[2]["pane"]
                    topic_id = child["id"]
                    pi_placement_ids = (pi_placement[1]["id"], pi_placement[2]["pane"])
                    assert (caller_fact["pid"], caller_fact["argv"], caller_fact["keep"]) == (
                        original_caller["pid"], original_caller["argv"], original_caller["keep"]), \
                        "Original caller process changed during the first command"
                    assert (caller_fact["foreground"]["pid"], caller_fact["foreground"]["argv"]) == (
                        original_caller["foreground"]["pid"], original_caller["foreground"]["argv"]), \
                        "Original caller foreground changed during the first command"
                    caller_identity = {k: caller_fact[k] for k in ("pid", "argv", "foreground", "keep")}
                    pi_identity = {k: fact[k] for k in ("pid", "argv", "foreground", "keep")}
                else:
                    assert child["id"] == topic_id, "Existing topic space was replaced"
                    assert [t["id"] for t in source_space["tabs"]] == [files_tab_id], \
                        "Original space did not retain only its Files tab"
                    assert caller_placement[0]["id"] == topic_id, "Caller did not move to the topic space"
                    assert (caller_placement[1]["id"], caller_placement[2]["pane"]) == (shell_tab_id, caller_pane)
                    assert (pi_placement[1]["id"], pi_placement[2]["pane"]) == pi_placement_ids
                    target_space = next(s for s in layout["spaces"] if s["id"] == topic_id)
                    moved_tab = next(t for t in target_space["tabs"] if t["id"] == shell_tab_id)
                    assert json.dumps(moved_tab, ensure_ascii=False).encode() == shell_bytes, "Caller tab changed"
                    assert {k: caller_fact[k] for k in caller_identity} == caller_identity, "Caller identity changed"
                    assert {k: fact[k] for k in pi_identity} == pi_identity, "Existing Pi identity changed"
                if index < 2:
                    selected = data("herdr-app", "status")
                    assert selected["space"] == child["id"] and selected["agent"] == terminal
            print("PASS: standalone wt-herdr groups, reuses and focuses one real Pi without changing caller cwd")
            print("PASS: after manual cd, repair preserves the Files tab and moves the intact caller tab")
            print("PASS: direct wt adds no app spaces or terminals")
            # The confirmation check needs Pi to be the only terminal in its space.
            # Kill only the owned caller after rechecking its identity and fixture location.
            assert caller in owned_terminals
            final_caller = rpc("terminal.get", terminal=caller)
            assert final_caller.get("state") == "live"
            assert {k: final_caller[k] for k in caller_identity} == caller_identity
            assert final_caller["foreground"]["cwd"] == str(fixture / "trees/topic")
            run("hc", "kill", caller)
            wait_for(lambda: rpc("terminal.get", terminal=caller).get("state") != "live",
                     "Fixture caller did not stop")
            wait_for(lambda: not any(p["terminal"] == caller for s in data("herdr-app", "ls")["spaces"]
                                     for t in s["tabs"] for p in t.get("terminals", [])),
                     "Fixture caller remains in the app layout")
            run("hc", "rm", caller)
            owned_terminals.remove(caller)
            assert not any(t["address"] == caller for t in rpc("terminal.list", all=True)["terminals"]), \
                "Fixture caller Core record remains"
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
            if driver is not None:
                driver.stop()
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
            for branch in ["topic", "direct"]:
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
            assert driver is None or driver.process.poll() is not None, "Rex bridge survived cleanup"
            print("PASS: owned Rex bridge, app terminals, spaces and fixture checkouts removed; existing terminals preserved")
    finally:
        # Stop the private fixture even when Herdr cleanup fails before reaching driver.stop().
        if driver is not None:
            driver.stop()
            assert driver.process.poll() is not None, "Rex bridge survived cleanup"
        # Keep a failed fixture when valuable files or worktree cleanup remain.
        if not (fixture_path / "trees").exists() or not list((fixture_path / "trees").iterdir()):
            shutil.rmtree(fixture_path)
        else:
            print(f"Fixture preserved for cleanup: {fixture_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
