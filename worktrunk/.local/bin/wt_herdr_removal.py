"""Guard every checkout conversation before deletion, close only recorded idle spaces."""

import copy
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

SHELLS = {"zsh", "bash", "sh", "fish", "dash", "ksh", "nu"}


class Removal:
    def __init__(self, helper):
        self.h = helper

    def fail(self, message):
        # Use the helper's public error type without loading another helper instance.
        raise self.h.error(message)

    @staticmethod
    def path(value):
        return str(Path(value).expanduser().resolve())

    def record_path(self, target):
        namespace = {k: v for k, v in self.h.namespace.items() if k != "core_id"}
        digest = hashlib.sha256(json.dumps([namespace, target], sort_keys=True).encode()).hexdigest()
        return self.h.state / (digest + ".remove.json")

    def processes(self):
        rows = {}
        raw = self.h.run(["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,tty=,lstart=,comm="])
        for line in raw.splitlines():
            parts = line.split(None, 10)
            if len(parts) != 11:
                self.fail("Cannot verify process inventory; removal refused")
            pid, parent, group, uid = map(int, parts[:4])
            rows[pid] = {"pid": pid, "parent": parent, "group": group, "uid": uid,
                         "tty": parts[4], "start": " ".join(parts[5:10]), "command": parts[10]}
        return rows

    @staticmethod
    def descendants(rows, pid):
        found = {pid}
        while True:
            more = {p for p, row in rows.items() if row["parent"] in found}
            if more <= found:
                return found
            found |= more

    @staticmethod
    def ancestors(rows, pid):
        found = set()
        while pid in rows and pid not in found:
            found.add(pid)
            pid = rows[pid]["parent"]
        return found

    @staticmethod
    def prompt_worker(row):
        # Powerlevel10k's persistent Git worker is shell infrastructure, not a user job.
        command = row["command"]
        return command == str(Path.home() / ".cache/gitstatus/gitstatusd-darwin-arm64")

    def infrastructure(self, rows, pid):
        allowed = set()
        for daemon, row in rows.items():
            if not self.prompt_worker(row) or row["tty"] != rows.get(pid, {}).get("tty"):
                continue
            group = {p for p, r in rows.items() if r["group"] == row["group"] and r["tty"] == row["tty"]}
            try:
                raw = self.h.run(["/bin/ps", "-p", ",".join(map(str, sorted(group))), "-o", "pid=,args="])
            except self.h.error:
                # The watchdog group can disappear during prompt refresh. No exemption
                # is granted from a failed read; caller settlement retries under its bound.
                continue
            args = {int(l.split(None, 1)[0]): l.split(None, 1)[1] for l in raw.splitlines() if len(l.split(None, 1)) == 2}
            tokens = args.get(daemon, "").split()
            if not any(tokens[i:i + 2] == ["-p", str(pid)] for i in range(len(tokens))):
                continue
            # Powerlevel10k uses a private job group with reparented zsh wrappers
            # and a five-second watchdog. Do not exempt arbitrary same-TTY jobs.
            if all(p in args and (p == daemon or args[p] in {"/bin/zsh -l", "sleep 5"}) for p in group):
                allowed |= group
        return allowed

    def terminal_processes(self, rows, pid):
        # A disowned or reparented job can retain the TTY after leaving shell ancestry.
        tty = rows.get(pid, {}).get("tty")
        return self.descendants(rows, pid) | {p for p, r in rows.items() if tty not in (None, "??") and r["tty"] == tty}

    def shell(self, address, fact, rows, caller=False, baseline=None):
        pid = fact.get("pid")
        argv = fact.get("argv") or []
        row = rows.get(pid)
        if (fact.get("state") != "live" or not row or row["uid"] != os.getuid()
                or not argv or Path(argv[0]).name not in SHELLS
                or Path(row["command"]).name not in SHELLS or row["tty"] == "??"):
            self.fail(f"Terminal {address} is not a verified shell; removal refused")
        identity = {"pid": pid, "start": row["start"], "argv": argv, "tty": row["tty"]}
        if baseline is not None and identity != baseline:
            self.fail(f"Terminal {address} changed identity; cleanup refused")
        ancestors = self.ancestors(rows, os.getpid())
        allowed = {pid}
        if baseline is not None:
            # Worktrunk's detached post hook inherits the old controlling TTY. It is
            # cleanup infrastructure, not a job in the returning interactive shell.
            own = self.ancestors(rows, os.getpid())
            if pid in own:
                self.fail("Cleanup must run outside the terminal being closed")
            allowed |= own | self.descendants(rows, os.getpid())
        if caller:
            # HC_TERMINAL_ID alone is not authority. The remover must descend from this shell.
            if pid not in ancestors:
                self.fail(f"Removal caller {address} is not an ancestor; removal refused")
            chain = self.descendants(rows, pid) & ancestors
            # Only shells may sit between the terminal root and the actual remover.
            # A Python/Node agent invoking wt is still active work, not a caller exception.
            ordered = []
            current = os.getpid()
            while current != pid:
                ordered.append(current)
                current = rows[current]["parent"]
            ordered.reverse()
            raw = self.h.run(["/bin/ps", "-p", ",".join(map(str, ordered)), "-o", "pid=,args="])
            arguments = {int(l.split(None, 1)[0]): l.split(None, 1)[1].split() for l in raw.splitlines() if len(l.split(None, 1)) == 2}
            entries = [shutil.which(name) for name in ("cop", "coppice")]
            def remover_process(p):
                if Path(rows[p]["command"]).name in {"wt", "cop"}:
                    return True
                argv = arguments.get(p, [])
                # The installed cop is a Python console script. Do not exempt Python
                # generally: require its exact installed entry and remove subcommand.
                return bool(len(argv) >= 3 and argv[2] == "remove" and any(
                    entry and self.path(argv[1]) == self.path(entry) for entry in entries))
            remover = next((i for i, p in enumerate(ordered) if remover_process(p)), None)
            if remover is None or any(Path(rows[p]["command"]).name not in SHELLS for p in ordered[:remover]):
                wrappers = ", ".join(Path(rows[p]["command"]).name for p in ordered[:remover])
                self.fail(f"Terminal {address} has active work above the remover ({wrappers}); removal refused")
            if any(Path(rows[p]["command"]).name not in SHELLS | {"wt", "cop", "uv", "python", "python3", "python3.13", "python3.14"}
                   for p in ordered[remover:]):
                self.fail(f"Terminal {address} has an unknown removal wrapper; removal refused")
            foreground = fact.get("foreground") or {}
            if foreground.get("pid") not in chain:
                self.fail(f"Terminal {address} foreground is not the remover; removal refused")
            allowed |= chain | self.descendants(rows, os.getpid())
        children = self.terminal_processes(rows, pid) - allowed
        jobs = sorted(children - self.infrastructure(rows, pid))
        if jobs:
            programs = ", ".join(sorted({Path(rows[p]["command"]).name for p in jobs}))
            self.fail(f"Terminal {address} has a running program or background job ({programs}); stop it before removal")
        foreground = fact.get("foreground") or {}
        if not caller and (foreground.get("pid") != pid or Path((foreground.get("argv") or [""])[0]).name not in SHELLS):
            self.fail(f"Terminal {address} has an active or unclear foreground program; stop it before removal")
        if (fact.get("status") or {}).get("app") not in (None, "shell"):
            self.fail(f"Terminal {address} reports an agent; stop it before removal")
        return identity

    def references(self, space):
        def nodes(node):
            yield node
            for child in [*node.get("children", []), *node.get("floating", [])]:
                yield from nodes(child)
        return [n["content"]["terminal"] for tab in space["tabs"] for n in nodes(tab["root"])
                if n.get("content", {}).get("terminal")]

    def core(self):
        core = self.h.json_command(["hc", "server", "status", "--json"])
        if not core.get("pid") or not core.get("core", {}).get("id"):
            self.fail("Core is unavailable; cannot establish safe Herdr cleanup. Use WT_HERDR_REMOVE=0 to opt out")
        return core["core"]["id"]

    def pending(self, target, spaces):
        for pending in self.h.state.glob("*.pending.json"):
            launch = json.loads(pending.read_text())
            if launch.get("path") == target or launch.get("space") in spaces:
                self.fail("A matching space has an uncertain launch; removal refused")

    def ownership(self, facts):
        ownership = {}
        for address, fact in facts.items():
            cwd = (fact.get("foreground") or {}).get("cwd")
            identity = self.h.git(cwd, required=False) if cwd else None
            ownership[address] = identity["path"] if identity else None
        return ownership

    def prepare(self, path):
        target = self.h.git(path)
        if self.path(path) != target["path"] or target["path"] == target["primary"]:
            self.fail("Removal must name a linked checkout root")
        core_id = self.core()
        doc, _ = self.h.snapshot()
        facts = self.h.facts()
        ownership = self.ownership(facts)
        spaces = []
        selected = set()
        preserved = set()
        relevant = set()
        for space in doc["spaces"]:
            addresses = self.references(space)
            paths = {a: ownership.get(a) for a in addresses}
            stored = self.path(space["folder"]) if space.get("folder") else None
            if stored != target["path"] and target["path"] not in paths.values():
                continue
            if any(p is None for p in paths.values()):
                self.fail(f"Space {space['id']} has unclear identity; removal refused")
            relevant.add(space["id"])
            target_addresses = {a for a, p in paths.items() if p == target["path"]}
            selected |= target_addresses
            # Space.folder is launch/mod context, not proof that every tab still
            # uses that checkout. Navigation into a shared space must not close it.
            if stored == target["path"] and all(p == target["path"] for p in paths.values()):
                spaces.append(copy.deepcopy(space))
            else:
                preserved.add(space["id"])
        caller = os.environ.get("HC_TERMINAL_ID")
        # Include every tab, hidden same-checkout terminal, and Core child terminal.
        for address, fact in facts.items():
            if fact.get("state") != "live" or address in selected:
                continue
            launch = self.h.git(fact.get("cwd"), required=False)
            unclear_target = ownership.get(address) is None and launch and launch["path"] == target["path"]
            if fact.get("parent") in selected or ownership.get(address) == target["path"] or unclear_target:
                self.fail(f"Terminal {address} is additional live checkout work; removal refused")
        self.pending(target["path"], relevant)
        record_path = self.record_path(target["path"])
        if not relevant:
            # An old failed attempt must not authorize closing a later conversation.
            record_path.unlink(missing_ok=True)
            return "No matching Herdr spaces; normal worktree removal"
        self.h.verify_target()
        self.pending(target["path"], relevant)
        if self.h.reconcile.exists():
            self.fail("Layout reconciliation is pending; run wt-herdr repair before removal")
        rows = self.processes()
        checked = {a: self.shell(a, facts[a], rows, caller=a == caller) for a in selected}
        # Record closure authority only for dedicated spaces. Shared target shells
        # still pass the same busy/caller guard but must survive post-remove cleanup.
        closing = {a for s in spaces for a in self.references(s)}
        self.h.app_layout(doc)
        refreshed = self.h.facts()
        if self.ownership(refreshed) != ownership:
            self.fail("Terminal checkout ownership changed during verification; retry removal")
        rows = self.processes()
        checked = {a: self.shell(a, refreshed[a], rows, caller=a == caller) for a in selected}
        self.pending(target["path"], relevant)
        if not spaces:
            record_path.unlink(missing_ok=True)
            return f"Verified target terminals; {len(preserved)} shared or stale-context spaces preserved"
        self.h.save(record_path, {"core_id": core_id, "target": target, "spaces": spaces,
                                  "terminals": {a: checked[a] for a in closing},
                                  "preserved_terminals": {a: checked[a] for a in selected - closing},
                                  "caller": caller if caller in closing else None})
        return f"Verified {len(spaces)} dedicated Herdr spaces; {len(preserved)} shared spaces preserved; cleanup follows removal"

    def finish(self, path):
        target_path = self.path(path)
        record_path = self.record_path(target_path)
        if not record_path.exists():
            return "No recorded Herdr cleanup"
        record = json.loads(record_path.read_text())
        if record["target"]["path"] != target_path or self.core() != record["core_id"]:
            self.fail("Recorded Core or checkout identity changed")
        primary = record["target"]["primary"]
        entries = self.h.run(["git", "-C", primary, "worktree", "list", "--porcelain", "-z"])
        if target_path in [self.path(x[9:]) for x in entries.split("\0") if x.startswith("worktree ")]:
            self.fail("Worktree is still registered; no Herdr space closed")
        self.h.verify_target()
        # Include hidden child terminals as well as every placed tab.
        def additional(facts):
            selected = set(record["terminals"])
            for address, fact in facts.items():
                if fact.get("state") != "live" or address in selected:
                    continue
                cwd = (fact.get("foreground") or {}).get("cwd") or fact.get("cwd")
                if address in record.get("preserved_terminals", {}) and cwd and self.path(cwd) == target_path:
                    self.shell(address, fact, rows, baseline=record["preserved_terminals"][address])
                    continue
                if fact.get("parent") in selected or (cwd and self.path(cwd) == target_path):
                    self.fail(f"Terminal {address} appeared after preparation; cleanup refused")

        # The caller can now be in primary or trash. Only its saved identity authorizes closure.
        while True:
            facts = self.h.facts()
            rows = self.processes()
            caller = record.get("caller")
            if caller and caller in facts and facts[caller].get("state") == "live":
                pid = record["terminals"][caller]["pid"]
                own = self.ancestors(rows, os.getpid()) | self.descendants(rows, os.getpid())
                if pid in own:
                    self.fail("Cleanup must run outside the terminal being closed")
                children = self.terminal_processes(rows, pid) - {pid} - own
                busy = sorted(children - self.infrastructure(rows, pid))
                if busy:
                    # No busy process is killed. Prompt refresh and remover wrappers get a
                    # bounded chance to settle; persistent jobs retain the cleanup record.
                    time.sleep(min(0.2, self.h.remaining()))
                    continue
            break
        closed = 0
        for saved in record["spaces"]:
            doc, _ = self.h.snapshot()
            current = next((s for s in doc["spaces"] if s["id"] == saved["id"]), None)
            if current is None:
                continue
            if current != saved:
                self.fail(f"Space {saved['id']} changed since preparation; cleanup refused")
            if self.core() != record["core_id"]:
                self.fail("Core changed during cleanup; closure refused")
            self.pending(target_path, {s["id"] for s in record["spaces"]})
            facts, rows = self.h.facts(), self.processes()
            additional(facts)
            for address in self.references(saved):
                if address not in facts:
                    self.fail(f"Terminal {address} disappeared unexpectedly")
                self.shell(address, facts[address], rows, baseline=record["terminals"][address])
                cwd = (facts[address].get("foreground") or {}).get("cwd")
                context = self.path(cwd) if cwd else None
                trash = self.path(record["target"]["common"]) + "/wt/trash/"
                allowed = context == target_path or (context and context.startswith(trash))
                if address == record.get("caller"):
                    allowed |= context == primary
                if not allowed:
                    self.fail(f"Terminal {address} moved outside the removed checkout; cleanup refused")
            self.h.app_layout(doc)
            # App closure ends terminals, so use only the exact, freshly verified space ID.
            self.h.json_command(["herdr-app", "do", "space.close", json.dumps({"id": saved["id"], "confirmed": True})])
            closed += 1
        doc, _ = self.h.snapshot()
        facts = self.h.facts()
        if any(s["id"] in {x["id"] for x in record["spaces"]} for s in doc["spaces"]):
            self.fail("Space closure has not converged")
        if any(facts.get(a, {}).get("state") == "live" for a in record["terminals"]):
            self.fail("Recorded terminals are still live")
        record_path.unlink()
        return f"Closed {closed} recorded idle Herdr spaces after worktree removal"
