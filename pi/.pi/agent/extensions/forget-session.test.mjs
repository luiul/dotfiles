/**
 * Test suite for forget-session.ts (run with Node 22+, no deps).
 *
 *   node --experimental-strip-types forget-session.test.mjs
 *
 * Resolves the extension next to this file. Each test runs against a fresh
 * temp PI_CODING_AGENT_DIR so the live memory store is never touched.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT ?? path.join(HERE, "forget-session.ts");

let pass = 0,
	fail = 0;
const check = (name, cond, extra) => {
	if (cond) {
		pass++;
		console.log("  \u2713", name);
	} else {
		fail++;
		console.log("  \u2717", name, extra ? JSON.stringify(extra) : "");
	}
};

function setup() {
	const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "forget-"));
	const MEM = path.join(ROOT, "pi-hermes-memory");
	fs.mkdirSync(MEM, { recursive: true });
	fs.mkdirSync(path.join(ROOT, "projects-memory", "proj"), { recursive: true });
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\n");
	fs.writeFileSync(path.join(MEM, "USER.md"), "ORIG-USER\n");
	fs.writeFileSync(path.join(ROOT, "projects-memory", "proj", "MEMORY.md"), "ORIG-PROJ\n");
	const DB = path.join(MEM, "sessions.db");
	const d = new DatabaseSync(DB);
	d.exec(
		"CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT);" +
			"CREATE TABLE session_files(path TEXT,session_id TEXT);" +
			"CREATE TABLE messages(id TEXT,session_id TEXT);" +
			"CREATE TABLE sessions(id TEXT PRIMARY KEY,name TEXT);",
	);
	d.prepare("INSERT INTO memories(content) VALUES(?)").run("pre1");
	d.prepare("INSERT INTO memories(content) VALUES(?)").run("pre2");
	d.close();
	return { ROOT, MEM, DB };
}

async function loadExt(ROOT, ctx) {
	process.env.PI_CODING_AGENT_DIR = ROOT;
	const handlers = {};
	const commands = {};
	const pi = {
		on: (e, f) => {
			(handlers[e] ||= []).push(f);
		},
		registerCommand: (n, d) => {
			commands[n] = d;
		},
	};
	const mod = await import(pathToFileURL(EXT).href + "?v=" + Math.random());
	mod.default(pi);
	const fire = async (e, ev = {}) => {
		for (const fn of handlers[e] || []) await fn(ev, ctx);
	};
	return { handlers, commands, fire };
}

const mkctx = (id) => ({
	sessionManager: { getSessionId: () => id, getHeader: () => ({ id }) },
	ui: { notify: () => {}, setStatus: () => {} },
});
const memCount = (DB) => {
	const d = new DatabaseSync(DB);
	const c = d.prepare("SELECT COUNT(*) c FROM memories").get().c;
	d.close();
	return c;
};
const memHas = (DB, content) => {
	const d = new DatabaseSync(DB);
	const c = d.prepare("SELECT COUNT(*) c FROM memories WHERE content=?").get(content).c;
	d.close();
	return c > 0;
};

// ── Test 1: forget at the very beginning (no writes yet) blocks + no-op cleanup
{
	console.log("Test 1: forget at beginning of session");
	const { ROOT, MEM, DB } = setup();
	const ctx = mkctx("S1");
	const { handlers, commands, fire } = await loadExt(ROOT, ctx);
	await fire("session_start", { reason: "startup" });
	const before = await handlers.tool_call[0]({ toolName: "memory" }, ctx);
	await commands["forget-session"].handler("", ctx);
	const after = await handlers.tool_call[0]({ toolName: "memory" }, ctx);
	check("not blocked before command", !before?.block);
	check("blocked after command", !!after?.block);
	check("skill_manage also blocked", !!(await handlers.tool_call[0]({ toolName: "skill_manage" }, ctx))?.block);
	check("unrelated tool not blocked", !(await handlers.tool_call[0]({ toolName: "bash" }, ctx))?.block);
	check("pre-existing memories intact", memCount(DB) === 2, { n: memCount(DB) });
	check("files untouched", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\n");
}

// ── Test 2: writes during session are restored/deleted by command
{
	console.log("Test 2: writes before command are undone");
	const { ROOT, MEM, DB } = setup();
	const ctx = mkctx("S2");
	const { commands, fire } = await loadExt(ROOT, ctx);
	await fire("session_start", { reason: "startup" });
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\nNEW\n");
	fs.writeFileSync(path.join(MEM, "NEWSKILL.md"), "x");
	{
		const d = new DatabaseSync(DB);
		d.prepare("INSERT INTO memories(content) VALUES(?)").run("sess");
		d.prepare("INSERT INTO sessions(id,name) VALUES(?,?)").run("S2", "n");
		d.close();
	}
	await commands["forget-session"].handler("", ctx);
	check("MEMORY.md restored", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\n");
	check("new file deleted", !fs.existsSync(path.join(MEM, "NEWSKILL.md")));
	check("session memory deleted", !memHas(DB, "sess"));
	check("pre memories intact", memCount(DB) === 2, { n: memCount(DB) });
	check(
		"session row deleted",
		(() => {
			const d = new DatabaseSync(DB);
			const c = d.prepare("SELECT COUNT(*) c FROM sessions WHERE id=?").get("S2").c;
			d.close();
			return c === 0;
		})(),
	);
}

// ── Test 3: post-shutdown subprocess pollution undone at next session
{
	console.log("Test 3: post-shutdown flush pollution undone next session");
	const { ROOT, MEM, DB } = setup();
	const ctxA = mkctx("S3");
	const A = await loadExt(ROOT, ctxA);
	await A.fire("session_start", { reason: "startup" });
	await A.commands["forget-session"].handler("", ctxA);
	await A.fire("session_shutdown", { reason: "quit" });
	// subprocess writes AFTER shutdown (forget-session is not loaded there):
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\nFLUSH\n");
	{
		const d = new DatabaseSync(DB);
		d.prepare("INSERT INTO memories(content) VALUES(?)").run("flush");
		d.close();
	}
	const ctxB = mkctx("S4");
	const B = await loadExt(ROOT, ctxB);
	await B.fire("session_start", { reason: "new" });
	check("MEMORY.md cleaned next session", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\n", {
		md: fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8"),
	});
	check("flush memory removed", !memHas(DB, "flush"));
	check("pre memories intact", memCount(DB) === 2, { n: memCount(DB) });
	check("marker cleared", !fs.existsSync(path.join(MEM, ".forget-session.json")));
}

// ── Test 4: reload mid-session keeps true baseline
{
	console.log("Test 4: reload keeps true baseline");
	const { ROOT, MEM, DB } = setup();
	const ctx = mkctx("S5");
	const A = await loadExt(ROOT, ctx);
	await A.fire("session_start", { reason: "startup" });
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\nWRITTEN\n");
	{
		const d = new DatabaseSync(DB);
		d.prepare("INSERT INTO memories(content) VALUES(?)").run("written");
		d.close();
	}
	// reload: fresh instance, same id
	const B = await loadExt(ROOT, ctx);
	await B.fire("session_start", { reason: "reload" });
	await B.commands["forget-session"].handler("", ctx);
	check("reverts to TRUE original after reload", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\n");
	check("written memory removed", !memHas(DB, "written"));
	check("pre memories intact", memCount(DB) === 2, { n: memCount(DB) });
}

// ── Test 5: non-forgotten session leaves no trace, deletes nothing
{
	console.log("Test 5: normal session does not delete anything");
	const { ROOT, MEM, DB } = setup();
	const ctx = mkctx("S6");
	const A = await loadExt(ROOT, ctx);
	await A.fire("session_start", { reason: "startup" });
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\nLEGIT\n");
	{
		const d = new DatabaseSync(DB);
		d.prepare("INSERT INTO memories(content) VALUES(?)").run("legit");
		d.close();
	}
	await A.fire("session_shutdown", { reason: "quit" });
	check("legit memory survives", memHas(DB, "legit"));
	check("legit markdown survives", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\nLEGIT\n");
	check("no marker left", !fs.existsSync(path.join(MEM, ".forget-session.json")));
}

// ── Test 6: null baseline (simulated DB read failure) must NOT wipe the store
{
	console.log("Test 6: null baseline must not wipe memory store");
	const { ROOT, MEM, DB } = setup();
	// three more memories so we can assert none get wiped
	{
		const d = new DatabaseSync(DB);
		for (let i = 0; i < 3; i++) d.prepare("INSERT INTO memories(content) VALUES(?)").run("keep" + i);
		d.close();
	}
	process.env.PI_CODING_AGENT_DIR = ROOT;
	// Plant a leftover marker + snapshot with maxMemoryId: null (baseline read failed).
	fs.writeFileSync(
		path.join(MEM, ".forget-session.json"),
		JSON.stringify({ sessionId: "OLD", pid: 999, activatedAt: new Date().toISOString() }),
	);
	fs.writeFileSync(
		path.join(MEM, ".forget-snapshot-OLD.json"),
		JSON.stringify({ sessionId: "OLD", files: { [path.join(MEM, "MEMORY.md")]: "ORIG-MEM\n" }, maxMemoryId: null }),
	);
	fs.writeFileSync(path.join(MEM, "MEMORY.md"), "ORIG-MEM\nPOLLUTION\n");
	const ctx = mkctx("NEW");
	const A = await loadExt(ROOT, ctx);
	await A.fire("session_start", { reason: "new" });
	check("all 5 pre-existing memories preserved (no wipe)", memCount(DB) === 5, { n: memCount(DB) });
	check("markdown still restored from snapshot", fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8") === "ORIG-MEM\n");
	check("marker cleared", !fs.existsSync(path.join(MEM, ".forget-session.json")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
