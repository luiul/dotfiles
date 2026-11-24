#!/usr/bin/env node
/** Deterministic retry ownership and title grammar checks, with mocked OS boundaries. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './fixtures/code-blocks-runtime.mjs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(process.env.TITLE_TEST_EXTENSION ?? join(repo, 'pi/.pi/agent/extensions/session-title.ts'), 'utf8');
const timers = new Set(), all = [], execs = [], titles = [];
let gitHead = 'ref: refs/heads/feature/title', git = true, linked = false, shutdown = false;
const timer = (fn, ms) => { const handle = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; timers.add(handle); all.push(handle); return handle; };
// Strip types, then inject only the OS and scheduling boundaries.
const transformed = stripTypeScriptTypes(source, { mode: 'strip' })
  .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1} = require("$2");')
  .replace('export default function', 'exports.default = function');
const exports = {};
const require = name => {
  if (name === 'node:child_process') return { spawnSync(bin, args, options) { execs.push({ bin, args, options }); return { stdout: 'ttys034\n' }; } };
  if (name === 'node:fs') return { existsSync(p) { return git && (p === '/fixture/repo/.git' || p === '/fixture/gitdir'); }, statSync() { return { isDirectory: () => !linked }; }, readFileSync(p) { return p.endsWith('HEAD') ? gitHead : 'gitdir: /fixture/gitdir'; } };
  if (name === 'node:os') return { homedir: () => '/fixture' };
  if (name === 'node:path') return { dirname: p => p === '/fixture/repo/sub' ? '/fixture/repo' : p.slice(0, p.lastIndexOf('/')) || '/', join: (...p) => p.join('/') };
  throw new Error('Unexpected dependency: ' + name);
};
new Function('exports', 'require', 'process', 'setTimeout', 'clearTimeout', transformed)(exports, require, { pid: 123, cwd: () => '/fixture/repo/sub' }, timer, handle => timers.delete(handle));
const events = {};
exports.default({ on(name, handler) { events[name] = handler; } });
const ctx = { mode: 'tui', hasUI: true, ui: { setTitle(title) { assert(!shutdown, 'stale context touched'); titles.push(title); } } };
await events.session_start({}, ctx);
assert.equal(timers.size, 9);
assert(all.every(h => h.unrefed), 'Retries must not keep the process alive');
await events.session_info_changed({}, ctx);
assert.equal(timers.size, 9, 'Replacement must cancel old retries');
for (const handle of [...timers]) { timers.delete(handle); handle.fn(); }
assert.equal(titles.at(-1), 'π • ~/repo • feature/title • ttys034');
assert(execs.every(call => call.options.timeout > 0 && call.options.timeout <= 2000), 'ps must have a short deadline');
assert.equal(execs.length, 1, 'TTY lookup stays process-cached');
linked = true; gitHead = 'abcdef123456'; await events.agent_start({}, ctx);
assert.equal(titles.at(-1), 'π • ~/repo • abcdef1 • ttys034');
git = false; await events.agent_settled({}, ctx);
assert.equal(titles.at(-1), 'π • ~/repo/sub • ttys034');
await events.session_start({}, ctx); assert.equal(timers.size, 9);
assert.equal(typeof events.session_shutdown, 'function'); await events.session_shutdown(); shutdown = true;
assert.equal(timers.size, 0, 'Shutdown cancels every retry');
const before = titles.length; for (const h of all) h.fn(); assert.equal(titles.length, before, 'Even queued callbacks cannot touch old context');
shutdown = false; await events.session_start({}, { ...ctx, mode: 'rpc' }); assert.equal(timers.size, 0, 'RPC has no terminal title retries');
await events.session_start({}, { ...ctx, hasUI: false }); assert.equal(timers.size, 0);
console.log('PASS title grammar, ps deadline/cache, unref, replacement and shutdown cleanup, queued callback guard and non-TUI ownership');
