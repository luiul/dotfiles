#!/usr/bin/env -S uv run --script
"""Guarded removal contract tests with mocked app, Core, Git, and processes.

Run: uv run --no-project --script scripts/test-wt-herdr-remove.py
No live commands run. Only temporary state files are written by the fixtures.
"""

import copy
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

BIN = Path(__file__).resolve().parents[1] / "worktrunk/.local/bin"


def load_source(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    # Loading production sources must not create files in the shared checkout.
    with patch.object(sys, "dont_write_bytecode", True):
        loader.exec_module(module)
    return module


helper_source = load_source("wt_herdr_remove_test_helper", BIN / "wt-herdr")
removal_source = load_source("wt_herdr_remove_test_module", BIN / "wt_herdr_removal.py")
Error = helper_source.Error


def tab(identifier, *addresses):
    return {
        "id": identifier,
        "name": "Custom tab",
        "root": {
            "id": identifier,
            "type": "row",
            "children": [
                {"id": "pane-" + address, "type": "block", "content": {"terminal": address}}
                for address in addresses
            ],
        },
    }


def space(identifier, folder, *tabs):
    return {"id": identifier, "name": "Custom space", "folder": folder, "tabs": list(tabs)}


class RemovalTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.primary = str(self.root / "repo")
        self.target = str(self.root / "feature")
        self.other = str(self.root / "other-feature")
        self.now = 0.0
        self.core_id = "original-core"
        self.registered = True
        self.rows = {}
        self.terminals = {}
        self.closed = []
        self.parent = space("repo-parent", self.primary, {
            "id": "files-tab", "name": "Files", "root": {
                "id": "files-tab", "type": "row", "children": [{
                    "id": "files-pane", "type": "block", "content": {
                        "mod": "files", "props": {"wt_herdr_parent": self.primary},
                    },
                }],
            },
        })
        self.doc = {"spaces": [copy.deepcopy(self.parent)]}

        self.h = Mock(spec=helper_source.Helper)
        self.h.error = Error
        self.h.namespace = {"app_home": str(self.root / "app"), "core_session": "default",
                            "state_home": str(self.root / "state")}
        self.h.state = self.root / "state"
        self.h.state.mkdir()
        self.h.deadline = 1.0
        self.h.reconcile = self.h.state / "reconcile.labels.json"
        self.h.run.side_effect = self.run_command
        self.h.json_command.side_effect = self.json_command
        self.h.verify_target.side_effect = self.verify_target
        self.h.snapshot.side_effect = lambda: (copy.deepcopy(self.doc), 1)
        self.h.facts.side_effect = lambda: copy.deepcopy(self.terminals)
        self.h.git.side_effect = self.git_identity
        self.h.app_layout.side_effect = self.app_layout
        self.h.save.side_effect = self.save_record
        self.h.remaining.side_effect = self.remaining
        self.removal = removal_source.Removal(self.h)

        for context in (
            patch.dict(os.environ, {}, clear=True),
            patch.object(removal_source.os, "getuid", return_value=501),
            patch.object(removal_source.os, "getpid", return_value=900),
            patch.object(removal_source.time, "monotonic", side_effect=lambda: self.now),
            patch.object(removal_source.time, "sleep", side_effect=self.advance_clock),
        ):
            context.start()
            self.addCleanup(context.stop)
        self.add_terminal("shell", 101)
        self.doc["spaces"].append(space("selected", self.target, tab("first-tab", "shell")))

    def add_process(self, pid, parent, command="/bin/zsh", start="Mon Jan 1 12:00:00 2024"):
        self.rows[pid] = {"pid": pid, "parent": parent, "group": pid, "uid": 501,
                          "tty": "ttys001" if pid in {101, 102, 103, 202, 203, 900} else f"ttys{pid}", "start": start, "command": command}

    def add_terminal(self, address, pid, cwd=None, parent=None):
        self.add_process(pid, 1)
        self.terminals[address] = {
            "address": address, "state": "live", "pid": pid, "argv": ["/bin/zsh", "-l"],
            "cwd": cwd or self.target,
            "foreground": {"pid": pid, "name": "zsh", "argv": ["/bin/zsh", "-l"],
                           "cwd": cwd or self.target},
            "status": {"app": "shell"}, "parent": parent,
        }

    def git_identity(self, folder, required=True):
        if folder:
            path = str(Path(folder).resolve())
            for root in (self.primary, self.target, self.other):
                if path == root or path.startswith(root + os.sep):
                    return {"path": root, "primary": self.primary,
                            "common": self.primary + "/.git", "name": Path(root).name}
        if required:
            raise Error("Fixture path is not a Git checkout")
        return None

    def run_command(self, args, **kwargs):
        if args == ["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,tty=,lstart=,comm="]:
            return "\n".join(
                f"{r['pid']} {r['parent']} {r['group']} {r['uid']} {r['tty']} {r['start']} {r['command']}"
                for r in self.rows.values()
            )
        if args[:2] == ["/bin/ps", "-p"] and args[-2:] == ["-o", "pid=,args="]:
            return "\n".join(f"{pid} {self.rows[pid]['command']}" for pid in map(int, args[2].split(",")) if pid in self.rows)
        if args == ["git", "-C", self.primary, "worktree", "list", "--porcelain", "-z"]:
            paths = [self.primary, self.other] + ([self.target] if self.registered else [])
            return "".join(f"worktree {path}\0HEAD {'a' * 40}\0branch refs/heads/fixture\0\0" for path in paths)
        raise AssertionError(f"Unexpected external command: {args}")

    def json_command(self, args, **kwargs):
        if args == ["hc", "server", "status", "--json"]:
            return {"pid": 50, "core": {"id": self.core_id}}
        if args[:3] == ["herdr-app", "do", "space.close"]:
            self.assertEqual(len(args), 4)
            payload = json.loads(args[3])
            self.assertEqual(payload, {"id": payload["id"], "confirmed": True})
            selected = next(s for s in self.doc["spaces"] if s["id"] == payload["id"])
            self.closed.append(payload["id"])
            for address, *_ in helper_source.placements({"spaces": [selected]}):
                self.terminals[address]["state"] = "exited"
            self.doc["spaces"].remove(selected)
            return {}
        raise AssertionError(f"Unexpected app/Core command: {args}")

    def verify_target(self):
        self.h.namespace["core_id"] = self.core_id

    def app_layout(self, doc=None):
        if doc is not None:
            self.assertEqual(doc, self.doc, "Removal must verify the exact current layout")

    def save_record(self, path, value):
        path.write_text(json.dumps(value))

    def remaining(self):
        remaining = self.h.deadline - self.now
        if remaining <= 0:
            raise Error("Operation deadline reached")
        return remaining

    def advance_clock(self, seconds):
        self.now += seconds

    def record_path(self):
        return self.removal.record_path(self.target)

    def prepare_idle(self):
        before = copy.deepcopy(self.doc)
        self.removal.prepare(self.target)
        self.assertEqual(self.doc, before, "Preparation must not edit app layout")
        self.assertEqual(self.closed, [])
        self.assertTrue(self.record_path().exists())
        return json.loads(self.record_path().read_text())

    def assert_prepare_refused(self, message):
        before = copy.deepcopy(self.doc)
        with self.assertRaisesRegex(Error, message):
            self.removal.prepare(self.target)
        self.h.save.assert_not_called()
        self.assertFalse(self.record_path().exists())
        self.assertEqual(self.closed, [])
        self.assertEqual(self.doc, before)

    def assert_finish_refused(self, message):
        before = copy.deepcopy(self.doc)
        record_before = self.record_path().read_bytes()
        with self.assertRaisesRegex(Error, message):
            self.removal.finish(self.target)
        self.assertEqual(self.closed, [])
        self.assertEqual(self.doc, before)
        self.assertEqual(self.record_path().read_bytes(), record_before,
                         "Refusal must retain the recovery record")

    def test_prepare_records_all_idle_tabs_but_preserves_repository_parent(self):
        self.add_terminal("second-shell", 201, cwd=self.target + "/src")
        self.doc["spaces"][1]["tabs"].append(tab("other-tab", "second-shell"))
        record = self.prepare_idle()
        self.assertEqual(record["target"], self.git_identity(self.target))
        self.assertEqual(record["spaces"], [self.doc["spaces"][1]])
        self.assertEqual(set(record["terminals"]), {"shell", "second-shell"})
        self.assertEqual(record["terminals"]["shell"]["pid"], 101)
        self.assertEqual(record["terminals"]["shell"]["start"], self.rows[101]["start"])
        self.assertEqual(record["core_id"], self.core_id)
        self.assertEqual(self.doc["spaces"][0], self.parent)
        self.h.verify_target.assert_called_with()
        self.h.app_layout.assert_any_call(self.doc)

    def test_prepare_blocks_real_agent_in_another_tab(self):
        self.add_terminal("agent-shell", 201)
        self.add_process(202, 201, "/opt/bin/node")
        self.terminals["agent-shell"]["foreground"].update(
            pid=202, name="node", argv=["/opt/bin/node", "/opt/bin/pi"])
        self.terminals["agent-shell"]["status"] = {"app": "pi", "state": "working"}
        self.doc["spaces"][1]["tabs"].append(tab("hidden-tab", "agent-shell"))
        self.assert_prepare_refused("running program|foreground|agent")

    def test_prepare_blocks_background_descendant_even_when_it_is_a_shell(self):
        self.add_process(202, 101, "/bin/bash")
        self.add_process(203, 202, "/bin/zsh")
        self.assert_prepare_refused("running program|background job")

    def shared_with_unrelated_agent(self):
        self.doc["spaces"][1]["folder"] = self.other
        self.add_terminal("unrelated-agent", 301, cwd=self.other)
        self.add_process(302, 301, "/opt/bin/node")
        self.terminals["unrelated-agent"]["foreground"].update(
            pid=302, name="node", argv=["/opt/bin/node", "/opt/bin/pi"])
        self.terminals["unrelated-agent"]["status"] = {"app": "pi", "state": "working"}
        self.doc["spaces"][1]["tabs"].append(tab("agent-tab", "unrelated-agent"))

    def test_prepare_refuses_unrelated_agent_entering_target_during_verification(self):
        self.shared_with_unrelated_agent()
        def navigate(doc=None):
            self.terminals["unrelated-agent"]["foreground"]["cwd"] = self.target
        self.h.app_layout.side_effect = navigate
        self.assert_prepare_refused("ownership changed")

    def test_prepare_pending_target_without_visible_space_blocks_removal(self):
        self.doc = {"spaces": [copy.deepcopy(self.parent)]}
        self.terminals = {}
        (self.h.state / "launch.pending.json").write_text(json.dumps({"path": self.target}))
        self.assert_prepare_refused("uncertain launch")

    def test_prepare_unknown_unplaced_target_terminal_blocks_removal(self):
        self.add_terminal("unknown", 201, cwd=self.target)
        self.terminals["unknown"]["foreground"] = {}
        self.assert_prepare_refused("additional live checkout work")

    def test_finish_pending_launch_after_preparation_blocks_closure(self):
        self.prepare_idle()
        self.registered = False
        (self.h.state / "launch.pending.json").write_text(json.dumps({"space": "selected"}))
        self.assert_finish_refused("uncertain launch")

    def test_finish_preserved_shell_starting_target_agent_blocks_dedicated_closure(self):
        self.shared_with_unrelated_agent()
        self.add_terminal("dedicated-shell", 201, cwd=self.target)
        self.doc["spaces"].append(space("dedicated", self.target, tab("dedicated-tab", "dedicated-shell")))
        self.removal.prepare(self.target)
        self.registered = False
        self.terminals["shell"]["status"] = {"app": "pi", "state": "working"}
        self.assert_finish_refused("agent")

    def test_prepare_self_removal_preserves_shared_space_and_unrelated_agent(self):
        self.shared_with_unrelated_agent()
        os.environ["HC_TERMINAL_ID"] = "shell"
        self.add_process(102, 101, "/opt/bin/wt")
        self.add_process(900, 102, "/opt/bin/python")
        before = copy.deepcopy(self.doc)
        facts_before = copy.deepcopy(self.terminals)
        result = self.removal.prepare(self.target)
        self.assertIn("preserved", result)
        self.assertEqual(self.doc, before)
        self.assertEqual(self.terminals, facts_before)
        self.assertFalse(self.record_path().exists())
        self.h.save.assert_not_called()
        self.assertEqual(self.removal.finish(self.target), "No recorded Herdr cleanup")
        self.assertEqual(self.closed, [])

    def test_prepare_shared_space_still_blocks_agent_using_target(self):
        self.shared_with_unrelated_agent()
        self.add_terminal("target-agent", 201, cwd=self.target)
        self.terminals["target-agent"]["status"] = {"app": "pi", "state": "working"}
        self.doc["spaces"][1]["tabs"].append(tab("target-agent-tab", "target-agent"))
        self.assert_prepare_refused("agent")

    def test_prepare_shared_space_still_blocks_target_background_job(self):
        self.shared_with_unrelated_agent()
        self.add_process(202, 101, "/bin/sleep")
        self.assert_prepare_refused("background job")

    def test_prepare_shared_space_refuses_unknown_terminal_checkout(self):
        self.shared_with_unrelated_agent()
        self.terminals["unrelated-agent"]["foreground"]["cwd"] = None
        self.assert_prepare_refused("unclear identity")

    def test_prepare_stale_space_folder_is_preserved_not_rejected(self):
        self.doc["spaces"][1]["folder"] = self.primary
        result = self.removal.prepare(self.target)
        self.assertIn("preserved", result)
        self.assertFalse(self.record_path().exists())
        self.assertEqual(self.closed, [])

    def test_prepare_stale_target_folder_does_not_authorize_unrelated_closure(self):
        self.terminals["shell"]["foreground"]["cwd"] = self.other
        self.removal.prepare(self.target)
        self.assertFalse(self.record_path().exists())
        self.assertEqual(self.closed, [])

    def test_finish_closes_dedicated_space_but_preserves_shared_space(self):
        self.shared_with_unrelated_agent()
        self.add_terminal("dedicated-shell", 201, cwd=self.target)
        dedicated = space("dedicated", self.target, tab("dedicated-tab", "dedicated-shell"))
        self.doc["spaces"].append(dedicated)
        before_shared = copy.deepcopy(self.doc["spaces"][1])
        self.removal.prepare(self.target)
        record = json.loads(self.record_path().read_text())
        self.assertEqual(record["spaces"], [dedicated])
        self.assertEqual(set(record["terminals"]), {"dedicated-shell"})
        self.registered = False
        self.terminals["shell"]["foreground"]["cwd"] = self.primary
        self.removal.finish(self.target)
        self.assertEqual(self.closed, ["dedicated"])
        self.assertEqual(self.doc["spaces"][1], before_shared)
        self.assertEqual(self.terminals["unrelated-agent"]["state"], "live")

    def test_prepare_blocks_unplaced_checkout_or_core_child_terminal(self):
        original = copy.deepcopy(self.doc)
        for kind in ("checkout", "child", "checkout-without-space"):
            with self.subTest(kind=kind):
                self.doc = copy.deepcopy(original)
                self.terminals.pop("unplaced", None)
                if kind == "checkout-without-space":
                    self.doc = {"spaces": [copy.deepcopy(self.parent)]}
                    self.terminals = {}
                self.add_terminal("unplaced", 201, cwd=self.other if kind == "child" else self.target,
                                  parent="shell" if kind == "child" else None)
                self.assert_prepare_refused("additional live checkout work")

    def test_prepare_blocks_uncertain_pending_launch_by_path_or_space(self):
        for pending in ({"path": self.target, "space": "different-space"},
                        {"path": self.other, "space": "selected"}):
            with self.subTest(pending=pending):
                (self.h.state / "launch.pending.json").write_text(json.dumps(pending))
                self.assert_prepare_refused("uncertain launch")

    def test_prepare_without_matching_spaces_leaves_no_cleanup_authority(self):
        self.doc = {"spaces": [copy.deepcopy(self.parent), space("unrelated", self.other)]}
        self.terminals = {}
        before = copy.deepcopy(self.doc)
        for stale_record in (False, True):
            with self.subTest(stale_record=stale_record):
                if stale_record:
                    self.record_path().write_text('{"stale": true}')
                self.assertIn("No matching", self.removal.prepare(self.target))
                self.assertFalse(self.record_path().exists())
                self.h.save.assert_not_called()
                self.assertEqual(self.doc, before)
                self.assertEqual(self.closed, [])

    def test_finish_refuses_a_still_registered_worktree(self):
        self.prepare_idle()
        self.assert_finish_refused("still registered")

    def test_finish_refuses_changed_core_and_retains_same_recovery_record(self):
        self.prepare_idle()
        recorded_path = self.record_path()
        self.registered = False
        self.core_id = "replacement-core"
        self.h.namespace["core_id"] = self.core_id
        self.assertEqual(self.record_path(), recorded_path)
        self.assert_finish_refused("Core.*identity changed|identity changed")

    def test_finish_refuses_changed_space_or_new_tab(self):
        self.prepare_idle()
        self.registered = False
        original = copy.deepcopy(self.doc)
        for mutation in ("name", "folder", "new-tab"):
            with self.subTest(mutation=mutation):
                self.doc = copy.deepcopy(original)
                if mutation == "new-tab":
                    self.doc["spaces"][1]["tabs"].append(tab("new-tab"))
                else:
                    self.doc["spaces"][1][mutation] = self.other
                self.assert_finish_refused("changed since preparation")

    def test_finish_refuses_terminal_pid_or_process_start_mismatch(self):
        self.prepare_idle()
        self.registered = False
        baseline_fact = copy.deepcopy(self.terminals["shell"])
        baseline_row = copy.deepcopy(self.rows[101])
        for mutation in ("pid", "start"):
            with self.subTest(mutation=mutation):
                self.terminals["shell"] = copy.deepcopy(baseline_fact)
                self.rows[101] = copy.deepcopy(baseline_row)
                if mutation == "pid":
                    self.add_process(301, 1)
                    self.terminals["shell"]["pid"] = 301
                    self.terminals["shell"]["foreground"]["pid"] = 301
                else:
                    self.rows[101]["start"] = "Tue Jan 2 12:00:00 2024"
                self.assert_finish_refused("changed identity")

    def test_finish_refuses_a_new_background_job(self):
        self.prepare_idle()
        self.registered = False
        self.add_process(202, 101, "/usr/bin/sleep")
        self.assert_finish_refused("running program|background job")

    def test_finish_closes_only_selected_spaces_and_preserves_unrelated_and_parent(self):
        self.add_terminal("second-shell", 201)
        self.add_terminal("unrelated-shell", 301, cwd=self.other)
        self.doc["spaces"].extend([
            space("second-selected", self.target, tab("second-tab", "second-shell")),
            space("unrelated", self.other, tab("unrelated-tab", "unrelated-shell")),
        ])
        self.add_process(302, 301, "/opt/bin/node")
        self.terminals["unrelated-shell"]["status"] = {"app": "pi", "state": "working"}
        unrelated = copy.deepcopy(self.doc["spaces"][-1])
        unrelated_fact = copy.deepcopy(self.terminals["unrelated-shell"])
        record = self.prepare_idle()
        self.assertEqual({s["id"] for s in record["spaces"]}, {"selected", "second-selected"})
        self.registered = False
        result = self.removal.finish(self.target)
        self.assertIn("Closed 2", result)
        self.assertEqual(self.closed, ["selected", "second-selected"])
        self.assertEqual(self.doc, {"spaces": [self.parent, unrelated]})
        self.assertEqual(self.terminals["unrelated-shell"], unrelated_fact)
        self.assertEqual(self.terminals["shell"]["state"], "exited")
        self.assertEqual(self.terminals["second-shell"]["state"], "exited")
        self.assertFalse(self.record_path().exists())
        self.assertIn(["git", "-C", self.primary, "worktree", "list", "--porcelain", "-z"],
                      [call.args[0] for call in self.h.run.call_args_list])

    def test_finish_busy_caller_is_deadline_bounded_and_never_closes_its_space(self):
        os.environ["HC_TERMINAL_ID"] = "shell"
        self.add_process(102, 101, "/opt/bin/wt")
        self.add_process(900, 102, "/opt/bin/python")
        record = self.prepare_idle()
        self.assertEqual(record["caller"], "shell")
        self.registered = False
        del self.rows[102]
        del self.rows[900]
        self.add_process(202, 101, "/bin/bash")
        self.assert_finish_refused("deadline")
        self.assertGreaterEqual(self.now, self.h.deadline)
        self.assertLess(self.now, self.h.deadline + 0.2)

    def test_prompt_group_exemption_requires_exact_daemon_owner(self):
        daemon = str(Path.home() / ".cache/gitstatus/gitstatusd-darwin-arm64")
        self.add_process(202, 1, "/bin/zsh")
        self.add_process(203, 202, daemon)
        self.rows[202]["group"] = self.rows[203]["group"] = 202
        original = self.h.run.side_effect

        def run(args, **kwargs):
            if args[:3] == ["/bin/ps", "-p", "202,203"]:
                return f"202 /bin/zsh -l\n203 {daemon} -p 101\n"
            return original(args, **kwargs)

        self.h.run.side_effect = run
        self.assertEqual(self.removal.infrastructure(self.rows, 101), {202, 203})
        self.rows[203]["command"] = "/tmp/gitstatusd-darwin-arm64"
        self.assertEqual(self.removal.infrastructure(self.rows, 101), set())
        self.assert_prepare_refused("background job")

    def test_cleanup_inside_recorded_terminal_is_refused(self):
        self.prepare_idle()
        self.registered = False
        self.add_process(900, 101, "/opt/bin/python")
        self.assert_finish_refused("outside the terminal")

    def test_prepare_refuses_active_program_above_remover(self):
        os.environ["HC_TERMINAL_ID"] = "shell"
        self.add_process(102, 101, "/opt/bin/python")
        self.add_process(103, 102, "/opt/bin/wt")
        self.add_process(900, 103, "/opt/bin/python")
        self.terminals["shell"]["foreground"]["pid"] = 102
        self.assert_prepare_refused("active work above")

    def test_prepare_refuses_reparented_same_tty_job(self):
        self.add_process(202, 1, "/bin/sleep")
        self.assert_prepare_refused("background job")

    def test_finish_preserves_shell_moved_to_unrelated_checkout(self):
        self.prepare_idle()
        self.registered = False
        self.terminals["shell"]["foreground"]["cwd"] = self.other
        self.assert_finish_refused("moved outside")

    def test_finish_refuses_reparented_same_tty_job(self):
        self.prepare_idle()
        self.registered = False
        self.add_process(202, 1, "/bin/sleep")
        self.assert_finish_refused("background job")

    def test_prepare_refuses_unclear_foreground_or_reported_agent(self):
        original = copy.deepcopy(self.terminals["shell"])
        for mutation in ("foreground", "status"):
            with self.subTest(mutation=mutation):
                self.terminals["shell"] = copy.deepcopy(original)
                if mutation == "foreground":
                    self.terminals["shell"]["foreground"] = {"cwd": self.target}
                else:
                    self.terminals["shell"]["status"] = {"app": "pi", "state": "done"}
                self.assert_prepare_refused("foreground|agent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
