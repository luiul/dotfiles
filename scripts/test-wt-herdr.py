#!/usr/bin/env -S uv run --script
"""Stdlib tests. Fake app/Core commands and real Git fixtures; no live app writes."""

import copy
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "worktrunk/.local/bin/wt-herdr"
loader = importlib.machinery.SourceFileLoader("wt_herdr", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
w = importlib.util.module_from_spec(spec)
loader.exec_module(w)


def tab(name, *addresses):
    return {"id": name, "name": "Custom tab", "root": {"id": name, "type": "row", "gap": 3,
        "children": [{"id": "p" + a, "type": "block", "size": {"weight": 0.5},
                      "content": {"terminal": a}} for a in addresses]}}


def space(name, folder, *tabs):
    return {"id": name, "name": "Custom space", "folder": folder, "tabs": list(tabs)}


def fact(address, cwd, pi=True):
    return {"address": address, "state": "live", "pid": 101, "argv": ["/bin/zsh", "-l"],
            "cwd": "/home", "foreground": {"pid": 202, "name": "node" if pi else "zsh",
                "argv": ["pi", ""] if pi else ["/bin/zsh", "-l"], "cwd": cwd},
            "reported": pi, "status": {"app": "pi", "state": "working"} if pi else None,
            "keep": True, "labels": {"herdr.pinned": "true"}, "screen": "PRIVATE",
            "msg": "PRIVATE", "title": "PRIVATE"}


class Harness(w.Helper):
    def __init__(self, root):
        root = root.resolve()
        self.root = root
        self.primary = str(root / "repo")
        self.child = str(root / "child")
        self.other = str(root / "other")
        for p in (self.primary, self.child, self.other):
            Path(p).mkdir(exist_ok=True)
        self.deadline = time.monotonic() + 10
        self.state = root / "state"
        self.state.mkdir()
        self.namespace = {"app_home": "default", "core_session": "default", "core_id": "core"}
        self.core_id = "core"
        self.key = "namespace"
        self.pending = self.state / "pending.json"
        self.reconcile = self.state / "labels.json"
        self.bins = {"pi": "/installed/pi"}
        self.git_cache = {}
        self.doc = {"spaces": [w.files_space(self.primary, "repo")]}
        self.version = 1
        self.terminals = {}
        self.calls = []
        self.conflict = False
        self.label_fail = False
        self.lost = False
        self.no_launch = False
        self.unreported = False
        self.bad_pair = False

    def git(self, folder, required=True):
        if folder in (self.primary, self.child, self.other):
            return {"path": folder, "primary": self.primary, "common": self.primary + "/.git",
                    "name": "repo" if folder == self.primary else "feature/name"}
        if required:
            raise w.Error("Not Git")
        return None

    def run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ["hc", "connect"]:
            request = json.loads(kwargs["input"])
            method, params = request["method"], request["params"]
            if method == "doc.get":
                result = {"value": copy.deepcopy(self.doc), "version": self.version}
            elif method == "terminal.list":
                result = {"terminals": list(self.terminals.values())}
            elif method == "doc.set":
                if self.conflict:
                    self.conflict = False
                    self.doc["unrelated"] = "concurrent edit"
                    self.version += 1
                    return json.dumps({"id": request["id"], "error": {"data": {"kind": "conflict"}, "msg": "PRIVATE"}})
                self.assert_version(params["version"])
                self.doc = copy.deepcopy(params["value"])
                self.version += 1
                result = {"version": self.version}
            elif method == "terminal.label":
                if self.label_fail:
                    self.label_fail = False
                    raise w.Error("Label failed")
                self.terminals[params["terminal"]]["labels"].update(params["labels"])
                result = self.terminals[params["terminal"]]
            else:
                raise AssertionError(method)
            return json.dumps({"id": request["id"], "result": result, "jsonrpc": "2.0"}) + "\n"
        if args[:3] == ["hc", "server", "status"]:
            return json.dumps({"pid": 10, "core": {"id": "core"}})
        if args == ["herdr-app", "ls"]:
            doc = copy.deepcopy(self.doc)
            for s in doc["spaces"]:
                s["machine"] = None
                for t in s["tabs"]:
                    t["terminals"] = [{"terminal": a, "pane": p} for a, _, _, p in w.placements({"spaces": [{**s, "tabs": [t]}]})]
            if self.bad_pair:
                doc["spaces"] = []
            return json.dumps(doc)
        if args == ["herdr-app", "status"]:
            focus = getattr(self, "focused", (None, None, None))
            return json.dumps({"space": focus[0], "tab": focus[1], "focused_pane": focus[2], "errors": []})
        if args[:2] == ["hc", "run"]:
            record = json.loads(self.pending.read_text())
            labels = dict(args[i + 1].split("=", 1) for i, arg in enumerate(args) if arg == "--label")
            assert labels["wt-herdr.launch"] == record["token"]
            assert "--no-parent" in args and "--no-notify" in args and "--keep" in args
            assert args[args.index("--") + 1:] == w.agent_argv([self.bins["pi"]])
            if not self.no_launch:
                target = next(s for s in self.doc["spaces"] if s["id"] == record["space"])
                target["tabs"].append(tab(record["tab"], "tnew"))
                self.terminals["tnew"] = fact("tnew", record["path"])
                self.terminals["tnew"]["labels"].update(labels)
                self.terminals["tnew"]["reported"] = not self.unreported
                self.version += 1
            if self.lost:
                raise w.Error("Reply lost")
            return '{"terminal":"tnew"}'
        if args[:2] == ["herdr-app", "do"]:
            command, params = args[2], json.loads(args[3])
            if command != "pane.focus":
                raise AssertionError(command)
            self.focused = next((s, t, p) for a, s, t, p in w.placements(self.doc) if a == params["terminal"])
            return "{}"
        raise AssertionError(args)

    def assert_version(self, version):
        if version != self.version:
            raise AssertionError("Stale CAS")

    def rpc_calls(self, method):
        # run arguments carry no terminal text. Count methods through a wrapping spy instead.
        return sum(c[0][0] == method for c in self.rpc.call_args_list)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.h = Harness(Path(self.tmp.name))
        self.h.rpc = Mock(wraps=self.h.rpc)
        self.repo = self.h.git(self.h.primary)
        self.target = self.h.git(self.h.child)

    def mixed(self):
        self.h.doc["spaces"].append(space("sp-mixed", "/home", tab("tb-mixed", "t1", "t2")))
        self.h.terminals = {"t1": fact("t1", self.h.child), "t2": fact("t2", self.h.primary)}

    def ready(self, pi=True):
        self.h.doc["spaces"].append(space("sp-child", self.h.child, tab("tb-child", "t1")))
        self.h.terminals = {"t1": fact("t1", self.h.child, pi)}

    def test_split_preserves_blocks_custom_names_parent_and_ids(self):
        self.mixed()
        original = copy.deepcopy(self.h.doc)
        ids, folders = self.h.identities(original, self.h.terminals)
        result = w.repair_layout(original, ids, folders)
        self.assertEqual(result["spaces"][0]["tabs"][0], original["spaces"][0]["tabs"][0])
        self.assertEqual(list(a for a, *_ in w.placements(result)), ["t2", "t1"])
        before_blocks = {n["id"]: n for s in original["spaces"] for t in s["tabs"] for n in w.nodes(t["root"]) if n["type"] == "block"}
        after_blocks = {n["id"]: n for s in result["spaces"] for t in s["tabs"] for n in w.nodes(t["root"]) if n["type"] == "block"}
        self.assertEqual(before_blocks, after_blocks)
        self.assertEqual(result["spaces"][1]["name"], "Custom space")
        self.assertEqual(result["spaces"][1]["tabs"][0]["id"], "tb-mixed")
        w.validate(result)

    def test_whole_tab_moves_retain_ids(self):
        self.mixed()
        self.h.doc["spaces"][1]["tabs"] = [tab("tb1", "t1"), tab("tb2", "t2")]
        ids, folders = self.h.identities(self.h.doc, self.h.terminals)
        result = w.repair_layout(self.h.doc, ids, folders)
        self.assertEqual({t["id"] for s in result["spaces"] for t in s["tabs"]},
                         {t["id"] for s in self.h.doc["spaces"] for t in s["tabs"]})

    def test_same_checkout_split_unchanged(self):
        self.ready()
        self.h.doc["spaces"][1]["tabs"] = [tab("tb-child", "t1", "t2")]
        self.h.terminals["t2"] = fact("t2", self.h.child)
        ids, folders = self.h.identities(self.h.doc, self.h.terminals)
        self.assertEqual(w.repair_layout(self.h.doc, ids, folders), self.h.doc)

    def test_mixed_mod_refused(self):
        self.mixed()
        self.h.doc["spaces"][1]["tabs"][0]["root"]["children"].append(
            {"id": "pmod", "type": "block", "content": {"mod": "files", "props": {}}})
        with self.assertRaisesRegex(w.Error, "mod"):
            self.h.repair()
        self.assertEqual(self.h.rpc_calls("doc.set"), 0)

    def test_unknown_context_refused(self):
        self.mixed()
        self.h.terminals["t2"]["foreground"]["cwd"] = "/unknown"
        with self.assertRaises(w.Error):
            self.h.repair()

    def test_repair_idempotent_and_sanitized_backup(self):
        self.mixed()
        before = w.process_identity(self.h.terminals)
        self.h.repair()
        writes = self.h.rpc_calls("doc.set")
        self.h.repair()
        self.assertEqual(self.h.rpc_calls("doc.set"), writes)
        self.assertEqual(before, w.process_identity(self.h.terminals))
        for backup in (self.h.state / "backups").glob("*.json"):
            self.assertNotIn("PRIVATE", backup.read_text())
        self.assertTrue(all(f["labels"]["herdr.pinned"] == "true" for f in self.h.terminals.values()))

    def test_layout_properties_survive_rpc_repair_and_backup(self):
        self.mixed()
        props = {"title": "Keep custom title", "msg": "Keep custom message", "screen": "custom"}
        self.h.doc["spaces"][0]["tabs"][0]["root"]["children"][0]["content"]["props"] = props
        self.h.doc["title"] = "Whole layout"
        self.h.repair()
        self.assertEqual(self.h.doc["title"], "Whole layout")
        self.assertEqual(self.h.doc["spaces"][0]["tabs"][0]["root"]["children"][0]["content"]["props"], props)
        backup = json.loads(next((self.h.state / "backups").glob("*.json")).read_text())
        self.assertEqual(backup["document"]["title"], "Whole layout")
        self.assertEqual(backup["document"]["spaces"][0]["tabs"][0]["root"]["children"][0]["content"]["props"], props)
        self.assertNotIn("PRIVATE", json.dumps(backup["facts"]))

    def test_missing_state_home_is_created(self):
        home = Path(self.tmp.name) / "fresh-home"
        (home / ".config/herdr-app").mkdir(parents=True)
        state = home / "new-state"
        with (patch.object(w.Path, "home", return_value=home),
              patch.dict(os.environ, {"HOME": str(home), "XDG_STATE_HOME": str(state),
                                      "HERDR_APP_HOME": str(home / ".config/herdr-app"), "HC_SESSION": "default"}),
              patch.object(w.shutil, "which", side_effect=lambda name: "/fake/" + name)):
            helper = w.Helper()
        self.assertTrue(helper.state.is_dir())

    def test_cas_conflict_preserves_concurrent_change(self):
        self.mixed()
        self.h.conflict = True
        self.h.repair()
        self.assertEqual(self.h.doc["unrelated"], "concurrent edit")
        self.assertEqual(self.h.rpc_calls("doc.set"), 2)

    def test_partial_label_failure_reruns_without_doc_write(self):
        self.mixed()
        self.h.label_fail = True
        with self.assertRaises(w.Error):
            self.h.repair()
        self.assertTrue(self.h.reconcile.exists())
        writes = self.h.rpc_calls("doc.set")
        self.h.repair()
        self.assertEqual(self.h.rpc_calls("doc.set"), writes)
        self.assertFalse(self.h.reconcile.exists())

    def test_recovery_ignores_unrelated_terminal_activity(self):
        self.mixed()
        self.h.terminals["outside"] = fact("outside", self.h.other)
        self.h.label_fail = True
        with self.assertRaises(w.Error):
            self.h.repair()
        del self.h.terminals["outside"]
        self.h.terminals["new-outside"] = fact("new-outside", self.h.other)
        self.h.repair()
        self.assertFalse(self.h.reconcile.exists())

    def test_saved_baseline_rejects_process_restart(self):
        self.mixed()
        self.h.label_fail = True
        with self.assertRaises(w.Error):
            self.h.repair()
        self.h.terminals["t1"]["pid"] += 1
        with self.assertRaisesRegex(w.Error, "baseline"):
            self.h.repair()

    def test_dry_run_no_records_no_doc_write(self):
        self.mixed()
        original = copy.deepcopy(self.h.doc)
        self.h.repair(True)
        self.assertEqual(self.h.doc, original)
        self.assertFalse(list(self.h.state.iterdir()))

    def test_reuse_active_pi_without_launch(self):
        self.ready()
        self.assertIn("Reused", self.h.open(self.repo, self.target))
        self.assertFalse(any(a[:2] == ["hc", "run"] for a in self.h.calls))

    def test_agent_launch_keeps_argv_out_of_shell_source(self):
        command = ["/tmp/a 'quoted' pi; $(not-a-command)", "", "task\nnext line"]
        for shell in ("/bin/sh", "/bin/bash", "/bin/zsh", "/usr/local/bin/fish"):
            for platform in ("darwin", "linux"):
                with self.subTest(shell=shell, platform=platform), patch.object(w.sys, "platform", platform):
                    argv = w.agent_argv(command, shell)
                    login = platform == "darwin"
                    self.assertEqual(argv[:2], [shell, "-lic" if login else "-ic"])
                    self.assertEqual(argv[3:], [shell, *command])
                    expected = ('command $argv[2..]; exec $argv[1] ' if shell.endswith("/fish")
                                else '\"$@\"; exec \"$0\" ')
                    self.assertEqual(argv[2], expected + ("-li" if login else "-i"))

    def test_agent_launch_uses_personal_shell_with_safe_default(self):
        with patch.dict(w.os.environ, {"SHELL": "/bin/zsh"}):
            self.assertEqual(w.agent_argv(["pi"])[0], "/bin/zsh")
        with patch.dict(w.os.environ, {}, clear=True):
            self.assertEqual(w.agent_argv(["pi"])[0], "/bin/sh")

    def test_shell_adds_tab_never_types(self):
        self.ready(False)
        self.assertIn("Opened", self.h.open(self.repo, self.target))
        launches = [a for a in self.h.calls if a[:2] == ["hc", "run"]]
        self.assertEqual(len(launches), 1)
        self.assertEqual(len(self.h.doc["spaces"]), 2)
        self.assertEqual(len(self.h.doc["spaces"][1]["tabs"]), 2)


    def test_external_pi_before_launch_is_reused(self):
        self.ready(False)
        original = self.h.app_layout

        def external_launch(doc=None):
            original(doc)
            self.h.terminals["t1"] = fact("t1", self.h.child)

        self.h.app_layout = external_launch
        self.assertIn("Reused", self.h.open(self.repo, self.target))
        self.assertFalse(any(a[:2] == ["hc", "run"] for a in self.h.calls))

    def test_lost_launch_reply_recovered_once(self):
        self.h.lost = True
        self.assertIn("Opened", self.h.open(self.repo, self.target))
        self.assertIn("Reused", self.h.open(self.repo, self.target))
        self.assertEqual(sum(a[:2] == ["hc", "run"] for a in self.h.calls), 1)

    def test_uncertain_pending_never_relaunches(self):
        self.h.no_launch = True
        self.h.deadline = time.monotonic() + 1
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)
        self.h.deadline = time.monotonic() + 1
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)
        self.assertEqual(sum(a[:2] == ["hc", "run"] for a in self.h.calls), 1)

    def test_pending_recovery_refuses_preexisting_pi(self):
        self.h.no_launch = True
        self.h.terminals["t1"] = fact("t1", self.h.child, False)
        self.h.deadline = time.monotonic() + 1
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)
        self.h.terminals["t1"] = fact("t1", self.h.child)
        record = json.loads(self.h.pending.read_text())
        target = next(s for s in self.h.doc["spaces"] if s["id"] == record["space"])
        target["tabs"].append(tab("tb-child", "t1"))
        self.h.deadline = time.monotonic() + 10
        with self.assertRaisesRegex(w.Error, "Another Pi"):
            self.h.open(self.repo, self.target)
        self.assertTrue(self.h.pending.exists())

    def test_other_actor_new_pi_does_not_clear_pending(self):
        self.h.no_launch = self.h.lost = True
        self.h.deadline = time.monotonic() + 1
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)
        record = json.loads(self.h.pending.read_text())
        target = next(s for s in self.h.doc["spaces"] if s["id"] == record["space"])
        target["tabs"].append(tab(record["tab"], "other-pi"))
        self.h.terminals["other-pi"] = fact("other-pi", self.h.child)
        self.h.terminals["other-pi"]["labels"].update({"herdr.space": record["space"], "herdr.tab": record["tab"]})
        self.h.deadline = time.monotonic() + 10
        with self.assertRaisesRegex(w.Error, "Another Pi"):
            self.h.open(self.repo, self.target)
        self.assertTrue(self.h.pending.exists())
        self.assertEqual(sum(a[:2] == ["hc", "run"] for a in self.h.calls), 1)

    def test_owned_pi_requires_exact_intended_tab(self):
        self.h.unreported = True
        self.h.deadline = time.monotonic() + 1
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)
        self.h.terminals["tnew"]["reported"] = True
        self.h.terminals["tnew"]["labels"]["herdr.tab"] = "another-tab"
        self.h.deadline = time.monotonic() + 10
        with self.assertRaisesRegex(w.Error, "labels disagree"):
            self.h.open(self.repo, self.target)
        self.assertTrue(self.h.pending.exists())

    def test_real_git_ignores_inherited_overrides(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        for repo in (self.h.primary, self.h.other):
            subprocess.run(["git", "init", "--quiet", repo], env=env, check=True,
                           capture_output=True, timeout=10)
        self.h.env = {**env, "GIT_DIR": self.h.other + "/.git", "GIT_WORK_TREE": self.h.other,
                      "GIT_COMMON_DIR": self.h.other + "/.git"}
        self.h.run = lambda args, **kw: w.Helper.run(self.h, args, **kw)
        identity = w.Helper.git(self.h, self.h.primary)
        self.assertEqual(identity["path"], self.h.primary)
        self.assertEqual(identity["common"], self.h.primary + "/.git")
        self.assertEqual(identity["primary"], self.h.primary)
        self.assertNotEqual(identity["common"], self.h.other + "/.git")

    def test_empty_git_folder_never_resolves_current_directory(self):
        with patch.object(w, "canonical", side_effect=AssertionError("Empty path canonicalized")):
            self.assertIsNone(w.Helper.git(self.h, "", required=False))
            self.assertIsNone(w.Helper.git(self.h, None, required=False))
            with self.assertRaises(w.Error):
                w.Helper.git(self.h, "")

    def test_label_only_repair_backed_up(self):
        self.ready(False)
        self.h.repair()
        self.assertEqual(self.h.rpc_calls("doc.set"), 0)
        self.assertEqual(len(list((self.h.state / "backups").glob("*.json"))), 1)

    def test_split_nested_containers_unique_ids(self):
        self.mixed()
        row = self.h.doc["spaces"][1]["tabs"][0]["root"]
        row["children"] = [{"id": "nested", "type": "column", "size": {"weight": 2},
                             "children": row["children"]}]
        identities, folders = self.h.identities(self.h.doc, self.h.terminals)
        result = w.repair_layout(self.h.doc, identities, folders)
        w.validate(result)
        nested = [n for s in result["spaces"] for t in s["tabs"] for n in w.nodes(t["root"]) if n["type"] == "column"]
        self.assertEqual(len(nested), 2)
        self.assertNotEqual(nested[0]["id"], nested[1]["id"])
        self.assertEqual(nested[0]["size"], nested[1]["size"])

    def test_unreported_pi_is_not_reused(self):
        self.ready()
        self.h.terminals["t1"]["reported"] = False
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)

    def test_title_and_status_without_program_not_reused(self):
        self.ready()
        self.h.terminals["t1"]["foreground"]["argv"] = ["not-pi"]
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)

    def test_multiple_pi_refused(self):
        self.ready()
        self.h.terminals["t2"] = fact("t2", self.h.child)
        with self.assertRaises(w.Error):
            self.h.open(self.repo, self.target)

    def test_mixed_open_requires_explicit_repair(self):
        self.mixed()
        with self.assertRaisesRegex(w.Error, "repair"):
            self.h.open(self.repo, self.target)

    def test_wrong_pair_fails_before_write(self):
        self.h.bad_pair = True
        with patch.object(w.time, "sleep"), self.assertRaisesRegex(w.Error, "pair"):
            self.h.verify_target()
        self.assertEqual(self.h.rpc_calls("doc.set"), 0)

    def test_null_status_safe(self):
        f = fact("t", self.h.child, False)
        self.assertFalse(w.is_pi(f, "/installed/pi"))

    def test_returned_shell_is_not_pi_even_with_stale_status(self):
        self.ready(False)
        returned = self.h.terminals["t1"]
        returned.update(reported=True, status={"app": "pi", "state": "idle"})
        self.assertFalse(w.is_pi(returned, self.h.bins["pi"]))
        with self.assertRaisesRegex(w.Error, "unverified"):
            self.h.reusable(self.h.doc, self.h.terminals, self.target)

    def test_remote_refused(self):
        self.h.doc["spaces"][0]["machine"] = "remote"
        with self.assertRaises(w.Error):
            w.validate(self.h.doc)

    def test_timeout_bounds_cleanup_and_kills_group(self):
        process = Mock(pid=999)
        process.communicate.side_effect = subprocess.TimeoutExpired("fake", 1)
        self.h.env = {}
        with (patch.object(w.subprocess, "Popen", return_value=process),
              patch.object(w.os, "killpg") as kill, self.assertRaises(w.Error)):
            w.Helper.run(self.h, ["fake"])
        kill.assert_called_once_with(999, w.signal.SIGKILL)
        self.assertEqual(process.communicate.call_args_list[-1].kwargs, {"timeout": 1})
        process.stdout.close.assert_called_once()
        process.wait.assert_called_once_with(timeout=1)

    def test_cli_check_subprocess_fake_commands(self):
        root = Path(self.tmp.name)
        home = root / "home"
        (home / ".config/herdr-app").mkdir(parents=True)
        (home / ".local/state").mkdir(parents=True)
        binaries = root / "bin"
        binaries.mkdir()
        fake = "#!" + sys.executable + "\n" + '''import json,sys,os
name=os.path.basename(sys.argv[0]); args=sys.argv[1:]; repo=os.environ['FAKE_REPO']
if name=='hc':
 if args[:2]==['server','status']: print(json.dumps({'pid':1,'core':{'id':'fake'}}))
 else:
  r=json.loads(sys.stdin.readline()); assert not sys.stdin.read()
  print(json.dumps({'id':r['id'],'result':{'value':{'spaces':[]},'version':0}}))
elif name=='herdr-app': print(json.dumps({'spaces':[]} if args==['ls'] else {'errors':[]}))
elif name=='git':
 args=args[2:]
 if args[:2]==['worktree','list']: sys.stdout.write('worktree '+repo+'\\0\\0')
 elif args[0]=='symbolic-ref': print('main')
 elif '--show-toplevel' in args: print(repo)
 else: print(repo+'/.git')
'''
        for name in ("hc", "herdr-app", "git", "pi"):
            (binaries / name).write_text(fake)
            (binaries / name).chmod(0o755)
        (Path(self.h.primary) / ".git").mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("HC_", "HERDR_", "XDG_"))}
        env.update(HOME=str(home), PATH=str(binaries) + os.pathsep + os.environ["PATH"], FAKE_REPO=self.h.primary)
        result = subprocess.run(["uv", "run", "--script", str(SOURCE), "check", "--repo", self.h.primary],
                                env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), {"message"})


if __name__ == "__main__":
    unittest.main()
