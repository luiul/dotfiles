#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Isolated Mail queue fixtures. Never change real Mail data or start Mail."""

from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import json
import os
import plistlib
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent.parent / "macos/.local/bin/mail-repair"
loader = importlib.machinery.SourceFileLoader("mail_repair", str(SCRIPT))
spec = importlib.util.spec_from_loader("mail_repair", loader)
repair = importlib.util.module_from_spec(spec)
loader.exec_module(repair)

# Captured V10 column layout, with no message content.
SCHEMA = """
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL,
 total_count INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0, deleted_count INTEGER DEFAULT 0,
 unseen_count INTEGER DEFAULT 0, unread_count_adjusted_for_duplicates INTEGER DEFAULT 0,
 change_identifier TEXT, source INTEGER, alleged_change_identifier TEXT);
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER,
 global_message_id INTEGER, remote_id INTEGER, document_id TEXT, sender INTEGER,
 subject_prefix TEXT, subject INTEGER, summary INTEGER, date_sent INTEGER,
 date_received INTEGER, mailbox INTEGER, remote_mailbox INTEGER, flags INTEGER,
 read INTEGER, flagged INTEGER, deleted INTEGER, size INTEGER, conversation_id INTEGER,
 date_last_viewed INTEGER, list_id_hash INTEGER, unsubscribe_type INTEGER,
 searchable_message INTEGER, brand_indicator INTEGER, display_date INTEGER,
 flag_color INTEGER, is_urgent INTEGER, color TEXT, type INTEGER, fuzzy_ancestor INTEGER,
 automated_conversation INTEGER, root_status INTEGER);
CREATE TABLE local_message_actions (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
 mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
 source_mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
 destination_mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
 action_type INTEGER, user_initiated INTEGER);
CREATE TABLE action_messages (ROWID INTEGER PRIMARY KEY,
 action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
 action_phase INTEGER, message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
 remote_id INTEGER, destination_message INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE);
CREATE TABLE action_flags (ROWID INTEGER PRIMARY KEY,
 action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
 flag_type INTEGER, flag_value INTEGER);
CREATE TABLE action_labels (ROWID INTEGER PRIMARY KEY,
 action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
 do_add INTEGER, label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE);
CREATE TABLE other_data (id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO mailboxes(ROWID,url) VALUES
 (12,'imap://fixture-account/GitHub%20Notifications'),
 (31,'imap://fixture-account/%5BGmail%5D/Trash');
INSERT INTO messages(ROWID,global_message_id,mailbox,size) VALUES(154391,26327,31,13294),(154392,26328,31,100);
INSERT INTO local_message_actions VALUES(22112,12,12,31,6,1),(22114,12,12,31,6,1),(22115,12,12,31,3,NULL);
INSERT INTO action_messages VALUES(1,22112,3,NULL,0,154391),(3,22114,3,NULL,109239,154392),(4,22115,1,154392,NULL,NULL);
INSERT INTO action_flags VALUES(1,22115,0,1);
INSERT INTO other_data VALUES(1,'unrelated fixture');
"""


class MailRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-mail-repair-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / "Library/Mail"
        self.data = self.root / "V10/MailData"
        self.data.mkdir(parents=True)
        self.db = self.data / "Envelope Index"
        with sqlite3.connect(self.db) as connection:
            connection.executescript(SCHEMA)
        (self.root / "PersistenceInfo.plist").write_bytes(plistlib.dumps({"LastUsedVersionDirectoryName": "V10"}))
        for name in repair.RULE_FILES:
            (self.data / name).write_bytes(plistlib.dumps({"fixture-rule": True}))
        reports = self.home / "Library/Logs/DiagnosticReports"
        reports.mkdir(parents=True)
        symbols = [
            "-[IMAPUIDCommand initWithMailboxName:UIDs:].cold.1",
            "-[ECTransferActionIMAPReplayer copyItems:destinationMailboxURL:]",
        ]
        self.report = reports / "Mail-fixture.ips"
        self.report.write_text(
            "{}\n" + json.dumps({"faultingThread": 0, "threads": [{"frames": [{"symbol": s} for s in symbols]}]})
        )
        self.rules_before = {name: (self.data / name).read_bytes() for name in repair.RULE_FILES}
        self.before = self.snapshot()

    def sql(self, query, parameters=()):
        with sqlite3.connect(self.db) as connection:
            return connection.execute(query, parameters).fetchall()

    def snapshot(self):
        with sqlite3.connect(self.db) as connection:
            return {
                name: connection.execute(f'SELECT * FROM "{name}" ORDER BY ROWID').fetchall()
                for name in repair.tables(connection)
            }

    def candidates(self):
        with contextlib.closing(repair.connect_readonly(self.db)) as connection:
            repair.check_database(connection)
            return repair.find_candidates(connection)

    def run_main(self, *args, check=lambda: None, confirm=lambda: "repair"):
        return repair.main(list(args), home=self.home, mail_check=check, confirm=confirm)

    def backups(self):
        base = self.home / "Library/Application Support/Mail Repair Backups"
        return [p for p in base.iterdir() if p.is_dir()] if base.exists() else []

    def backup(self):
        base = self.home / "Library/Application Support/Mail Repair Backups"
        repair.private_directory(base)
        with contextlib.closing(repair.connect_readonly(self.db)) as connection:
            return repair.create_backup(connection, self.data, base, self.candidates())

    def test_repair_removes_only_target_rows_and_preserves_rules(self):
        self.assertEqual(self.run_main(), 0)
        after = self.snapshot()
        for table, rows in self.before.items():
            expected = rows
            if table == "action_messages":
                expected = [r for r in rows if r[0] != 1]
            elif table == "local_message_actions":
                expected = [r for r in rows if r[0] != 22112]
            self.assertEqual(after[table], expected, table)
        for name, content in self.rules_before.items():
            self.assertEqual((self.data / name).read_bytes(), content)
        self.assertEqual(len(self.backups()), 1)
        with sqlite3.connect(self.backups()[0] / "Envelope Index") as saved:
            self.assertEqual(saved.execute("SELECT count(*) FROM local_message_actions").fetchone()[0], 3)
            self.assertEqual(saved.execute("PRAGMA quick_check").fetchone()[0], "ok")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(self.backups()), 1)

    def test_dry_run_does_not_write_files(self):
        self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.backups(), [])

    def test_cancel_and_noninteractive_repair_do_not_write(self):
        self.assertEqual(self.run_main(confirm=lambda: "no"), 0)
        self.assertEqual(self.run_main(confirm=None), 1)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.backups(), [])

    def test_backup_only_includes_wal_and_private_permissions(self):
        with sqlite3.connect(self.db) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO other_data VALUES(2,'committed WAL row')")
            writer.commit()
            self.assertTrue(Path(str(self.db) + "-wal").exists())
            before = self.snapshot()
            self.assertEqual(self.run_main("--backup-only"), 0)
            self.assertEqual(self.snapshot(), before)
            saved = self.backups()[0]
            self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o700)
            for p in saved.iterdir():
                self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
            with contextlib.closing(repair.connect_readonly(saved / "Envelope Index")) as backup:
                self.assertEqual(backup.execute("SELECT count(*) FROM other_data").fetchone()[0], 2)
                self.assertEqual(backup.execute("PRAGMA journal_mode").fetchone()[0], "delete")
            manifest = json.loads((saved / "manifest.json").read_text())
            self.assertEqual(manifest["counts"]["other_data"], 2)
            self.assertEqual(set(manifest["files"]), {"Envelope Index", "PersistenceInfo.plist", *repair.RULE_FILES})

    def test_mail_running_is_refused_before_inspection(self):
        def running():
            raise repair.RepairError("Quit Mail first")

        self.assertEqual(self.run_main(check=running), 1)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.backups(), [])

    def test_mail_launch_before_commit_rolls_back(self):
        saved = self.backup()
        calls = 0

        def check():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise repair.RepairError("Mail started during repair")

        with self.assertRaises(repair.RepairError):
            repair.apply_repair(self.db, saved, self.candidates(), check)
        self.assertEqual(self.snapshot(), self.before)

    def test_changed_queue_after_confirmation_is_refused(self):
        def confirm():
            self.sql("UPDATE action_messages SET remote_id=99 WHERE ROWID=1")
            return "repair"

        self.assertEqual(self.run_main(confirm=confirm), 1)
        self.assertEqual(len(self.sql("SELECT * FROM local_message_actions")), 3)
        self.assertEqual(self.backups(), [])

    def test_other_database_changes_after_backup_are_refused(self):
        saved = self.backup()
        candidates = self.candidates()
        self.sql("INSERT INTO other_data VALUES(2,'newer row')")
        with self.assertRaises(repair.RepairError):
            repair.apply_repair(self.db, saved, candidates, lambda: None)
        self.assertEqual(len(self.sql("SELECT * FROM local_message_actions")), 3)
        self.assertEqual(len(self.sql("SELECT * FROM other_data")), 2)

    def test_duplicate_multiplicity_and_implicit_row_identity_are_checked(self):
        self.sql("CREATE TABLE duplicate_data (value TEXT)")
        self.sql("INSERT INTO duplicate_data VALUES('same')")
        self.sql("INSERT INTO duplicate_data VALUES('same')")
        saved = self.backup()
        candidates = self.candidates()
        for mutation, undo in (
            ("INSERT INTO duplicate_data VALUES('same')", "DELETE FROM duplicate_data WHERE rowid=3"),
            ("DELETE FROM duplicate_data WHERE rowid=2", "INSERT INTO duplicate_data(rowid,value) VALUES(2,'same')"),
            ("UPDATE duplicate_data SET rowid=3 WHERE rowid=2", "UPDATE duplicate_data SET rowid=2 WHERE rowid=3"),
        ):
            self.sql(mutation)
            with self.assertRaises(repair.RepairError):
                repair.apply_repair(self.db, saved, candidates, lambda: None)
            self.assertEqual(len(self.sql("SELECT * FROM local_message_actions")), 3)
            self.sql(undo)

    def test_dry_run_discloses_wal_sidecars_and_keeps_database_bytes(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
        content = self.db.read_bytes()
        import io

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertIn("WAL coordination files", output.getvalue())
        self.assertEqual(self.db.read_bytes(), content)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(self.backups(), [])

    def test_mixed_valid_and_invalid_items_in_one_action_are_refused(self):
        self.sql("INSERT INTO action_messages VALUES(9,22112,3,NULL,100,154392)")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(len(self.sql("SELECT * FROM action_messages")), 4)

    def test_missing_retained_message_is_refused(self):
        self.sql("DELETE FROM messages WHERE ROWID=154391")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(len(self.sql("SELECT * FROM local_message_actions")), 3)

    def test_retained_message_in_wrong_mailbox_is_refused(self):
        self.sql("UPDATE messages SET mailbox=12 WHERE ROWID=154391")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.backups(), [])

    def test_live_source_message_is_refused(self):
        self.sql("UPDATE action_messages SET message=154392 WHERE ROWID=1")
        self.assertEqual(self.run_main(), 1)

    def test_dependent_flags_are_refused(self):
        self.sql("INSERT INTO action_flags VALUES(2,22112,1,1)")
        self.assertEqual(self.run_main(), 1)

    def test_cross_account_copy_is_refused(self):
        self.sql("UPDATE mailboxes SET url='imap://another-account/Trash' WHERE ROWID=31")
        self.assertEqual(self.run_main(), 1)

    def test_null_and_negative_uids_match_but_other_phases_do_not(self):
        for uid in (None, -1, 0):
            self.sql("UPDATE action_messages SET remote_id=? WHERE ROWID=1", (uid,))
            self.assertEqual(len(self.candidates()), 1)
        self.sql("UPDATE action_messages SET action_phase=1 WHERE ROWID=1")
        self.assertEqual(self.candidates(), [])

    def test_unknown_version_is_refused(self):
        (self.root / "PersistenceInfo.plist").write_bytes(plistlib.dumps({"LastUsedVersionDirectoryName": "V11"}))
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.backups(), [])

    def test_changed_foreign_keys_are_refused(self):
        with sqlite3.connect(self.db) as connection:
            connection.executescript("""
                ALTER TABLE action_flags RENAME TO old_flags;
                CREATE TABLE action_flags (ROWID INTEGER PRIMARY KEY, action INTEGER,
                    flag_type INTEGER, flag_value INTEGER);
                INSERT INTO action_flags SELECT * FROM old_flags;
                DROP TABLE old_flags;
            """)
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.backups(), [])

    def test_multiple_invalid_single_item_actions_are_repaired(self):
        self.sql("UPDATE action_messages SET remote_id=0 WHERE ROWID=3")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.sql("SELECT ROWID FROM local_message_actions"), [(22115,)])
        self.assertEqual(len(self.sql("SELECT * FROM messages")), 2)

    def test_unknown_columns_and_triggers_are_refused(self):
        self.sql("ALTER TABLE action_messages ADD COLUMN new_field INTEGER")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.backups(), [])

    def test_unrelated_triggers_do_not_block_queue_repair(self):
        self.sql("CREATE TRIGGER message_trigger AFTER DELETE ON messages BEGIN DELETE FROM other_data; END")
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.snapshot()["messages"], self.before["messages"])
        self.assertEqual(self.snapshot()["other_data"], self.before["other_data"])

    def test_unknown_incoming_queue_dependency_is_refused(self):
        self.sql(
            "CREATE TABLE extra_dependency (action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE)"
        )
        self.sql("INSERT INTO extra_dependency VALUES(22112)")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.sql("SELECT * FROM extra_dependency"), [(22112,)])

    def test_trigger_is_refused(self):
        self.sql("CREATE TRIGGER unsafe AFTER DELETE ON action_messages BEGIN DELETE FROM other_data; END")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.snapshot()["other_data"], self.before["other_data"])

    def test_missing_and_stale_crash_evidence_is_refused(self):
        os.utime(self.report, (0, 0))
        self.assertEqual(self.run_main(), 1)
        self.report.unlink()
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertEqual(self.backups(), [])

    def test_invalid_crash_json_is_ignored(self):
        self.report.write_text("{}\nnot json")
        self.assertFalse(repair.crash_evidence(self.home))

    def test_lock_blocks_parallel_run_and_releases(self):
        base = self.home / "backups"
        with repair.repair_lock(base):
            with self.assertRaises(repair.RepairError):
                with repair.repair_lock(base):
                    self.fail("Second lock acquired")
        with repair.repair_lock(base):
            pass

    def test_symlink_and_public_backup_directory_are_refused(self):
        public = self.home / "public"
        public.mkdir(mode=0o755)
        with self.assertRaises(repair.RepairError):
            repair.private_directory(public)
        link = self.home / "link"
        link.symlink_to(public, target_is_directory=True)
        with self.assertRaises(repair.RepairError):
            repair.private_directory(link)

    def test_corrupt_database_is_refused(self):
        self.db.write_bytes(b"not sqlite")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.backups(), [])

    def test_cli_unknown_flags_and_conflicting_modes_fail_before_work(self):
        for args in (("--yes",), ("--dry-run", "--backup-only")):
            with self.assertRaises(SystemExit) as error:
                self.run_main(*args)
            self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.snapshot(), self.before)


if __name__ == "__main__":
    unittest.main()
