#!/usr/bin/env -S uv run --script
"""Safety tests for scoped terminal tab handoff using the fake Herdr harness."""

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


TESTS = Path(__file__).with_name("test-wt-herdr.py")
spec = importlib.util.spec_from_file_location("wt_herdr_tests", TESTS)
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
w = existing.w


class HandoffSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.h = existing.Harness(Path(self.tmp.name))
        self.h.rpc = Mock(wraps=self.h.rpc)
        self.repo_a = self.h.git(self.h.primary)
        self.repo_b = {
            "path": self.h.other,
            "primary": self.h.other,
            "common": self.h.other + "/.git",
            "name": "other",
        }
        original_git = self.h.git

        def git(folder, required=True):
            if folder == self.h.other:
                return self.repo_b
            return original_git(folder, required)

        self.h.git = git
        files = {
            "id": "tb-files",
            "name": "Files",
            "root": {
                "id": "tb-files",
                "type": "row",
                "children": [{"id": "p-files", "type": "block",
                              "content": {"mod": "files", "props": {"folder": "keep"}}}],
            },
        }
        self.moved = existing.tab("tb-moved", "moving")
        self.source = existing.space("sp-source", self.h.primary, files, self.moved)
        self.destination = existing.space(
            "sp-destination", self.h.other, existing.tab("tb-destination", "resident")
        )
        self.h.doc["spaces"].extend([self.source, self.destination])
        self.h.terminals.update({
            "moving": existing.fact("moving", self.h.other, False),
            "resident": existing.fact("resident", self.h.other, False),
        })
        self.h.terminals["resident"]["pid"] += 1
        self.h.terminals["resident"]["foreground"]["pid"] += 1
        self.h.terminals["resident"]["labels"].update(
            {"herdr.space": "sp-destination", "herdr.tab": "tb-destination"}
        )

    def assert_no_writes(self, original_doc, original_labels):
        self.assertEqual(self.h.rpc_calls("doc.set"), 0)
        self.assertEqual(self.h.rpc_calls("terminal.label"), 0)
        self.assertEqual(self.h.doc, original_doc)
        self.assertEqual({a: f["labels"] for a, f in self.h.terminals.items()}, original_labels)

    def labels(self):
        return copy.deepcopy({a: f["labels"] for a, f in self.h.terminals.items()})

    def assert_moved_once_to_destination(self):
        locations = [(s["id"], t) for s in self.h.doc["spaces"] for t in s["tabs"]
                     if t["id"] == self.moved["id"]]
        self.assertEqual(locations, [("sp-destination", self.moved)])
        source = next(s for s in self.h.doc["spaces"] if s["id"] == "sp-source")
        self.assertEqual([t["id"] for t in source["tabs"]], ["tb-files"])
        destination = next(s for s in self.h.doc["spaces"] if s["id"] == "sp-destination")
        self.assertEqual([t["id"] for t in destination["tabs"]], ["tb-destination", "tb-moved"])

    def test_scoped_repair_moves_tab_to_existing_out_of_scope_destination(self):
        before = w.process_identity(self.h.terminals)
        resident_labels = self.labels()["resident"]
        self.h.repair(repo=self.repo_a)
        self.assert_moved_once_to_destination()
        self.assertEqual(w.process_identity(self.h.terminals), before)
        self.assertEqual(self.h.terminals["resident"]["labels"], resident_labels)
        self.assertEqual(self.h.terminals["moving"]["labels"]["herdr.space"], "sp-destination")
        self.assertEqual(self.h.terminals["moving"]["labels"]["herdr.tab"], "tb-moved")

    def test_destination_foreground_change_before_cas_refuses_all_writes(self):
        original_doc = copy.deepcopy(self.h.doc)
        original_labels = self.labels()
        facts = self.h.facts
        calls = 0

        def changing_facts():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.h.terminals["resident"]["foreground"]["cwd"] = self.h.primary
            return facts()

        error = None
        with patch.object(self.h, "facts", side_effect=changing_facts):
            try:
                self.h.repair(repo=self.repo_a)
            except w.Error as exc:
                error = exc
        self.assertGreaterEqual(calls, 2, "fixture must change the destination before doc.set")
        self.assertEqual(self.h.terminals["resident"]["foreground"]["cwd"], self.h.primary)
        self.assert_no_writes(original_doc, original_labels)
        self.assertIsNotNone(error, "repair must refuse a changed destination foreground")

    def assert_unknown_container_content_refused(self, container):
        root = self.moved["root"]
        if container == "column":
            root["children"] = [{"id": "col", "type": "column", "children": root["children"]}]
            node = root["children"][0]
        else:
            node = root
        node["content"] = {"widget": "unknown", "props": {"folder": "keep"}}
        original_doc = copy.deepcopy(self.h.doc)
        original_labels = self.labels()
        error = None
        try:
            self.h.repair(repo=self.repo_a)
        except w.Error as exc:
            error = exc
        self.assert_no_writes(original_doc, original_labels)
        self.assertIsNotNone(error, "repair must refuse unknown container content")

    def test_unknown_row_content_refused_before_writes(self):
        self.assert_unknown_container_content_refused("row")

    def test_unknown_column_content_refused_before_writes(self):
        self.assert_unknown_container_content_refused("column")

    def test_pending_launch_in_destination_refuses_before_writes(self):
        pending = self.h.state / "other.pending.json"
        record = {"space": "sp-destination", "path": self.h.other}
        pending.write_text(json.dumps(record))
        original_doc = copy.deepcopy(self.h.doc)
        original_labels = self.labels()
        with self.assertRaisesRegex(w.Error, "uncertain launch"):
            self.h.repair(repo=self.repo_a)
        self.assert_no_writes(original_doc, original_labels)
        self.assertEqual(json.loads(pending.read_text()), record)

    def test_scoped_handoff_is_immediately_idempotent_across_repos(self):
        self.h.repair(repo=self.repo_a)
        original = copy.deepcopy(self.h.doc)
        writes = self.h.rpc_calls("doc.set")
        labels = self.h.rpc_calls("terminal.label")
        self.assertIn("layout change False, 0 label updates", self.h.repair(dry_run=True, repo=self.repo_a))
        self.h.repair(repo=self.repo_a)
        self.assertEqual(self.h.doc, original)
        self.assertEqual(self.h.rpc_calls("doc.set"), writes)
        self.assertEqual(self.h.rpc_calls("terminal.label"), labels)

    def test_cas_conflict_replans_handoff_without_duplicate_tabs(self):
        before = w.process_identity(self.h.terminals)
        resident_labels = self.labels()["resident"]
        self.h.conflict = True
        self.h.repair(repo=self.repo_a)
        self.assertEqual(self.h.rpc_calls("doc.set"), 2)
        self.assertEqual(self.h.doc["unrelated"], "concurrent edit")
        self.assert_moved_once_to_destination()
        self.assertEqual(w.process_identity(self.h.terminals), before)
        self.assertEqual(self.h.terminals["resident"]["labels"], resident_labels)
        self.assertEqual(self.h.terminals["moving"]["labels"]["herdr.space"], "sp-destination")
        self.assertEqual(self.h.terminals["moving"]["labels"]["herdr.tab"], "tb-moved")
        self.assertFalse(self.h.reconcile.exists())
        mutations = [(c.args[0], c.kwargs) for c in self.h.rpc.call_args_list
                     if c.args[0] in ("doc.set", "terminal.label")]
        self.assertEqual([method for method, _ in mutations],
                         ["doc.set", "doc.set", "terminal.label"])
        self.assertEqual(mutations[-1][1]["terminal"], "moving")


if __name__ == "__main__":
    unittest.main()
