#!/usr/bin/env node
/** Pure injected fixtures. No Rex calls, real files or real signals. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { register, audit, complete, auditFailed } from '../macos/.local/bin/reap-rex-tests.mjs';

const uid = 501, home = '/Users/fixture', root = '/private/tmp/ag-rex-tests-nonce123';
const cache = `${home}/.cache`, registry = `${cache}/rex-test-tasks`;
const nonce = '0123456789abcdef0123456789abcdef', file = `${registry}/${nonce}.json`;
const escalationFile = `${registry}/${nonce}.escalation.json`;
const claimFile = `${registry}/${createHash('sha256').update(root).digest('hex')}.registration-claim`;
const grace = 10_000;
const manifestFile = `${root}/manifest.json`, targetFile = `${root}/targets.json`, socketFile = `${root}/server.sock`;
const deadline = 1_800_000_000_000;
const start = `${uid} Mon Nov 9 12:34:56 2026`, reused = `${uid} Tue Nov 10 12:34:56 2026`;
const manifest = () => ({ root, endpoint: `unix://${socketFile}`, deadline, ownerPid: 200,
  ownerIdentity: start, supervisorPid: 201, supervisorIdentity: start, serverPid: 202,
  serverIdentity: start, instanceId: 'private-instance', socketIdentity: { dev: 1, ino: 4 } });
let count = 0;
function absent() { return Object.assign(new Error('absent'), { code: 'ENOENT' }); }
function fixture({ registered = true, controller = false } = {}) {
  const nodes = new Map(), handles = new Map(), mutations = [], lookups = [], signals = [], reads = [];
  let sequence = 10, nextFd = 100, now = deadline - 1, hook = () => {}, signalHook = () => {};
  const processes = new Map([[200, start], [201, start], [202, start], [203, start]]);
  const initial = manifest();
  if (controller) { initial.controllerPid = 204; initial.controllerIdentity = start; processes.set(204, start); }
  const make = (type, ino, mode, text = '') => ({ type, ino, dev: 1, uid, mode, text, nlink: 1,
    mtimeMs: 0, ctimeMs: 0 });
  nodes.set(cache, make('directory', 1, 0o700));
  nodes.set(root, make('directory', 2, 0o700));
  nodes.set(manifestFile, make('file', 3, 0o600, JSON.stringify(initial)));
  nodes.set(socketFile, make('socket', 4, 0o600));
  const get = name => { const n = nodes.get(name); if (!n) throw absent(); return n; };
  const stat = n => ({ ...n, size: Buffer.byteLength(n.text),
    isDirectory: () => n.type === 'directory', isFile: () => n.type === 'file',
    isSocket: () => n.type === 'socket', isSymbolicLink: () => n.type === 'symlink' });
  const files = {
    constants: fs.constants,
    lstatSync: name => { reads.push(name); return stat(get(name)); },
    realpathSync: name => get(name).canonical ?? name,
    fstatSync: fd => stat(handles.get(fd)),
    openSync(name, flags, mode) {
      let n;
      if (flags & fs.constants.O_CREAT) {
        mutations.push(['open', name]);
        if (nodes.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        n = make('file', sequence++, mode); nodes.set(name, n);
      } else n = get(name);
      if (n.type === 'symlink') throw new Error('symlink refused');
      const fd = nextFd++; handles.set(fd, n); return fd;
    },
    closeSync: fd => handles.delete(fd),
    readFileSync(fd) { return typeof fd === 'number' ? handles.get(fd).text : get(fd).text; },
    writeFileSync(fd, text) { mutations.push(['write', fd]); handles.get(fd).text = text; },
    fsyncSync(fd) { assert(handles.has(fd)); mutations.push(['fsync', fd]); },
    renameSync(from, to) { mutations.push(['rename', from, to]); nodes.set(to, get(from)); nodes.delete(from); },
    mkdirSync(name, { mode }) { mutations.push(['mkdir', name]); nodes.set(name, make('directory', sequence++, mode)); },
    readdirSync(name) { return [...nodes.keys()].filter(p => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes('/')).map(p => p.slice(name.length + 1)); },
    unlinkSync(name) { mutations.push(['unlink', name]); nodes.delete(name); },
  };
  const deps = { files, home, uid, selfPid: 200, nonce: () => nonce, clock: () => now,
    ps: pid => { lookups.push(pid); hook(pid, lookups.length); return processes.has(pid) ? processes.get(pid) : null; },
    signal: (pid, sig) => { signals.push([pid, sig]); signalHook(pid, sig); } };
  const f = { nodes, deps, signals, mutations, lookups, reads, processes,
    patch(name, values) { Object.assign(get(name), values); },
    json(name, transform) { const n = get(name); const value = JSON.parse(n.text); transform(value); n.text = JSON.stringify(value); },
    targets(list = [{ pid: 203, identity: start }]) { nodes.set(targetFile, make('file', 5, 0o600, JSON.stringify(list))); },
    put(name, type = 'file', mode = 0o600, text = '') { nodes.set(name, make(type, sequence++, mode, text)); },
    expire() { now = deadline; processes.delete(200); processes.delete(201); deps.selfPid = 999; },
    set now(value) { now = value; },
    set hook(value) { hook = value; },
    set signalHook(value) { signalHook = value; },
    run(apply = true) { return audit({ apply }, deps); },
    register() { return register(root, deps); },
    complete() { return complete(root, deps); },
    reset() { mutations.length = 0; lookups.length = 0; reads.length = 0; },
  };
  if (registered) f.register();
  f.reset();
  return f;
}
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
function onlyStateWrites(f, { completed = false } = {}) {
  for (const [operation, name, to] of f.mutations) {
    if (operation === 'write' || operation === 'fsync') continue;
    if (operation === 'open') assert.equal(name, `${escalationFile}.${nonce}.tmp`);
    else if (operation === 'rename') assert.equal(to, escalationFile);
    else if (operation === 'unlink' && completed) assert([escalationFile, file].includes(name));
    else assert.fail(`unexpected mutation ${operation} ${name}`);
  }
}
function noActions(f, reason) {
  const report = f.run();
  assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, []);
  if (reason) assert.match(report.tasks[0]?.reason ?? report.errors.join(' '), reason);
  return report;
}

test('registration pins immutable fields, root and socket inode in a nonce 0600 record', () => {
  const f = fixture({ registered: false }); const r = f.register();
  assert.deepEqual(r, { id: nonce, file, root });
  assert.equal(f.nodes.get(registry).mode, 0o700); assert.equal(f.nodes.get(file).mode, 0o600);
  const stored = JSON.parse(f.nodes.get(file).text);
  assert.deepEqual(stored.rootIdentity, { dev: 1, ino: 2 });
  assert.deepEqual(stored.manifest, manifest()); assert.equal(stored.uid, uid);
  assert.equal(f.nodes.has(targetFile), false);
});
test('supervisor can register before readiness; unrelated caller cannot', () => {
  const f = fixture({ registered: false }); f.deps.selfPid = 201; f.register();
  const other = fixture({ registered: false }); other.deps.selfPid = 999;
  assert.throws(() => other.register(), /only the owner or supervisor/); assert.deepEqual(other.mutations, []);
});
test('normal shared endpoint refused before any writes or signals', () => {
  const f = fixture({ registered: false });
  f.json(manifestFile, m => { m.endpoint = 'unix:///Users/fixture/.config/rex/server.sock'; });
  assert.throws(() => f.register(), /exact private test endpoint/); assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.signals, []);
  assert.throws(() => register('/Users/fixture/.config/rex', f.deps), /private Rex test root/);
});
for (const [label, change] of [
  ['root alias', f => f.patch(root, { canonical: '/other' })],
  ['root symlink', f => f.patch(root, { type: 'symlink' })],
  ['root mode', f => f.patch(root, { mode: 0o755 })],
  ['root UID', f => f.patch(root, { uid: uid + 1 })],
  ['manifest symlink', f => f.patch(manifestFile, { type: 'symlink' })],
  ['manifest mode', f => f.patch(manifestFile, { mode: 0o644 })],
  ['manifest hard link', f => f.patch(manifestFile, { nlink: 2 })],
  ['expired deadline', f => { f.now = deadline; }],
  ['server identity mismatch', f => f.processes.set(202, reused)],
  ['dead supervisor', f => f.processes.delete(201)],
  ['workload already published', f => f.targets()],
  ['pending workload request', f => f.put(`${root}/123-abcd.target.json`, 'file', 0o600, '{}')],
  ['socket replacement', f => f.patch(socketFile, { ino: 88 })],
]) test(`registration refuses ${label} without mutation`, () => {
  const f = fixture({ registered: false }); change(f);
  assert.throws(() => f.register()); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
});
test('existing unsafe registry is refused, never chmodded', () => {
  const f = fixture({ registered: false }); f.put(registry, 'directory', 0o755);
  assert.throws(() => f.register(), /directory mode/); assert.deepEqual(f.mutations, []);
});
test('second registration refuses duplicate before writes even with a new nonce', () => {
  const f = fixture(); const before = JSON.stringify([...f.nodes]);
  f.deps.nonce = () => 'e'.repeat(32);
  assert.throws(() => f.register(), /already registered/);
  assert.equal(JSON.stringify([...f.nodes]), before); assert.deepEqual(f.mutations, []);
  assert(!f.nodes.has(claimFile));
});
test('unregistered fixtures and normal servers are not discovered, including dry-run', () => {
  const f = fixture({ registered: false }); f.expire(); f.targets();
  f.put(`${home}/.config/rex/server.sock`, 'socket'); f.processes.set(900, start);
  assert.deepEqual(f.run().tasks, []); assert.deepEqual(f.run(false).tasks, []);
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, []);
});
test('dry-run has zero writes for eligible, fully completed, and absent registry cases', () => {
  for (const completed of [false, true]) {
    const f = fixture(); f.expire(); f.targets();
    if (completed) { f.processes.delete(202); f.processes.delete(203); f.nodes.delete(socketFile); }
    const before = JSON.stringify([...f.nodes]); const report = f.run(false);
    assert.equal(report.tasks[0].status, 'eligible'); assert.equal(report.tasks[0].registeredProcessesGone, completed);
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []); assert.equal(JSON.stringify([...f.nodes]), before);
  }
  const f = fixture({ registered: false }); f.run(false); assert.deepEqual(f.mutations, []);
});
test('expired dead controllers allow only registered server and target SIGTERM', () => {
  const f = fixture(); f.expire(); f.targets(); f.processes.set(777, start);
  f.put(`${root}/unregistered.pid`, 'file', 0o600, '777');
  const report = f.run();
  assert.deepEqual(f.signals, [[202, 'SIGTERM'], [203, 'SIGTERM']]); onlyStateWrites(f);
  assert.equal(report.tasks[0].status, 'retained'); assert.deepEqual(report.tasks[0].remaining, [202, 203]);
  assert.equal(report.unknownSelfDetachingChildren, 'unresolved');
  assert.equal(report.cleanupScope, 'server-and-registered-targets-only');
  assert(!f.lookups.includes(777)); assert(!f.reads.includes(`${root}/unregistered.pid`));
});
for (const [label, change] of [
  ['unexpired deadline', f => { f.now = deadline - 1; }],
  ['live owner', f => f.processes.set(200, start)],
  ['live supervisor', f => f.processes.set(201, start)],
  ['reused owner PID', f => f.processes.set(200, reused)],
  ['reused supervisor PID', f => f.processes.set(201, reused)],
  ['reused server PID', f => f.processes.set(202, reused)],
  ['reused target PID', f => f.processes.set(203, reused)],
  ['ps inspection failure', f => { f.hook = () => { throw new Error('ps failed'); }; }],
  ['ps unknown identity', f => f.processes.set(202, undefined)],
  ['registry file symlink', f => f.patch(file, { type: 'symlink' })],
  ['registry file mode', f => f.patch(file, { mode: 0o640 })],
  ['registry file UID', f => f.patch(file, { uid: uid + 1 })],
  ['registry hard link', f => f.patch(file, { nlink: 2 })],
  ['registry directory symlink', f => f.patch(registry, { type: 'symlink' })],
  ['registry directory mode', f => f.patch(registry, { mode: 0o755 })],
  ['cache writable by others', f => f.patch(cache, { mode: 0o777 })],
  ['registry ancestor alias', f => f.patch(cache, { canonical: '/elsewhere' })],
  ['corrupt record', f => f.patch(file, { text: '{' })],
  ['record ID mismatch', f => f.json(file, r => { r.id = 'f'.repeat(32); })],
  ['record UID mismatch', f => f.json(file, r => { r.uid++; })],
  ['record version mismatch', f => f.json(file, r => { r.version = 2; })],
  ['root replacement', f => f.patch(root, { ino: 88 })],
  ['root symlink', f => f.patch(root, { type: 'symlink' })],
  ['root permissions changed', f => f.patch(root, { mode: 0o750 })],
  ['root disappeared', f => f.nodes.delete(root)],
  ['socket replacement', f => f.patch(socketFile, { ino: 88 })],
  ['socket symlink', f => f.patch(socketFile, { type: 'symlink' })],
  ['socket mode', f => f.patch(socketFile, { mode: 0o666 })],
  ['socket UID', f => f.patch(socketFile, { uid: uid + 1 })],
  ['missing socket of live server', f => f.nodes.delete(socketFile)],
  ['manifest endpoint changed', f => f.json(manifestFile, m => { m.endpoint = 'unix:///tmp/shared.sock'; })],
  ['manifest instance changed', f => f.json(manifestFile, m => { m.instanceId = 'different'; })],
  ['manifest server PID changed', f => f.json(manifestFile, m => { m.serverPid = 204; })],
  ['manifest deadline changed', f => f.json(manifestFile, m => { m.deadline--; })],
  ['manifest socket identity changed', f => f.json(manifestFile, m => { m.socketIdentity.ino++; })],
  ['manifest corrupt', f => f.patch(manifestFile, { text: '{}' })],
  ['manifest oversized', f => f.patch(manifestFile, { text: ' '.repeat(1024 * 1024 + 1) })],
  ['target UID changed', f => f.targets([{ pid: 203, identity: start.replace('501', '502') }])],
  ['target identity malformed', f => f.targets([{ pid: 203, identity: `${uid} nonsense` }])],
  ['target owner PID', f => f.targets([{ pid: 200, identity: start }])],
  ['target supervisor PID', f => f.targets([{ pid: 201, identity: start }])],
  ['target server PID', f => f.targets([{ pid: 202, identity: start }])],
  ['target audit PID', f => f.targets([{ pid: 999, identity: start }])],
  ['target PID one', f => f.targets([{ pid: 1, identity: start }])],
  ['duplicate targets', f => f.targets([{ pid: 203, identity: start }, { pid: 203, identity: start }])],
  ['target file corrupt', f => f.patch(targetFile, { text: '{}' })],
  ['target file null', f => f.patch(targetFile, { text: 'null' })],
  ['target file symlink', f => f.patch(targetFile, { type: 'symlink' })],
  ['target file mode', f => f.patch(targetFile, { mode: 0o644 })],
]) test(`audit skips ${label} without signals or writes`, () => {
  const f = fixture(); f.expire(); f.targets(); change(f); noActions(f);
});
test('age alone never allows cleanup', () => {
  const f = fixture(); f.now = deadline + 30 * 86400_000; f.targets(); noActions(f, /owner is alive/);
});
test('mutable manifest additions do not invalidate pinned fields', () => {
  const f = fixture(); f.expire(); f.json(manifestFile, m => { m.debug = 'dynamic'; });
  f.run(); assert.deepEqual(f.signals, [[202, 'SIGTERM']]);
});
for (const [label, change] of [
  ['root replaced', f => f.patch(root, { ino: 88 })],
  ['socket replaced', f => f.patch(socketFile, { ino: 88 })],
  ['registry directory replaced', f => f.patch(registry, { ino: 88 })],
  ['record replaced', f => f.patch(file, { ino: 88 })],
  ['record content changed', f => f.json(file, r => { r.extra = true; })],
  ['target list changed', f => f.targets([])],
  ['owner resurrected', f => f.processes.set(200, start)],
  ['supervisor PID reused', f => f.processes.set(201, reused)],
  ['server PID reused', f => f.processes.set(202, reused)],
  ['deadline no longer expired', f => { f.now = deadline - 1; }],
]) test(`pre-signal revalidation refuses ${label}`, () => {
  const f = fixture(); f.expire(); f.targets();
  let triggered = false;
  f.hook = (_pid, n) => { if (n >= 5 && !triggered) { triggered = true; change(f); } };
  noActions(f); assert(triggered);
});
test('storage change during initial ps checks blocks the first signal', () => {
  const f = fixture(); f.expire(); f.targets();
  f.hook = (_pid, n) => { if (n === 1) f.patch(root, { ino: 88 }); };
  noActions(f);
});
test('last PID inspection refuses identity reuse', () => {
  const f = fixture(); f.expire(); f.targets();
  let inspections = 0;
  f.hook = pid => { if (pid === 202 && ++inspections === 3) f.processes.set(202, reused); };
  noActions(f); assert.equal(inspections, 3);
});
test('storage change during last PID inspection refuses signal', () => {
  const f = fixture(); f.expire();
  let inspections = 0;
  f.hook = pid => { if (pid === 202 && ++inspections === 3) f.patch(socketFile, { ino: 88 }); };
  noActions(f); assert.equal(inspections, 3);
});
test('each signal revalidates, so first signal cannot authorize a changed second target', () => {
  const f = fixture(); f.expire(); f.targets(); f.signalHook = () => f.processes.set(203, reused);
  const report = f.run(); assert.deepEqual(f.signals, [[202, 'SIGTERM']]);
  assert.equal(report.tasks[0].status, 'retained'); assert.deepEqual(f.mutations, []);
});
test('signal failure retains evidence without unlink or escalation', () => {
  const f = fixture(); f.expire(); f.signalHook = () => { throw new Error('permission denied'); };
  const report = f.run(); assert.equal(report.tasks[0].status, 'skipped');
  assert.match(report.tasks[0].reason, /permission denied/); assert.deepEqual(f.mutations, []);
});
test('only completed registry is removed after registered processes and socket are gone', () => {
  const f = fixture(); f.expire(); f.targets();
  f.processes.delete(202); f.processes.delete(203); f.nodes.delete(socketFile);
  const report = f.run(); assert.equal(report.tasks[0].status, 'completed');
  assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, [['unlink', file]]);
  assert(f.nodes.has(root)); assert(f.nodes.has(manifestFile)); assert(f.nodes.has(targetFile));
  assert.equal(report.tasks[0].unknownSelfDetachingChildren, 'unresolved');
});
test('successful TERM can complete only when exact registered processes and socket disappear', () => {
  const f = fixture(); f.expire(); f.targets();
  f.signalHook = pid => { f.processes.delete(pid); if (pid === 202) f.nodes.delete(socketFile); };
  const report = f.run(); assert.equal(report.tasks[0].status, 'completed');
  assert.deepEqual(f.signals, [[202, 'SIGTERM'], [203, 'SIGTERM']]);
  onlyStateWrites(f, { completed: true });
  assert.deepEqual(f.mutations.filter(m => m[0] === 'unlink'), [['unlink', escalationFile], ['unlink', file]]);
});
test('dead processes with a lingering socket retain the record', () => {
  const f = fixture(); f.expire(); f.processes.delete(202);
  const report = noActions(f); assert.equal(report.tasks[0].status, 'retained');
});
test('replacement socket even with dead processes is not completion proof', () => {
  const f = fixture(); f.expire(); f.processes.delete(202); f.patch(socketFile, { ino: 88 }); noActions(f);
});
test('invalid registry names do not reach arbitrary paths or processes', () => {
  const f = fixture({ registered: false }); f.put(registry, 'directory', 0o700);
  f.put(`${registry}/not-a-nonce.json`, 'file', 0o600, JSON.stringify({ root: '/shared' }));
  noActions(f, /registry filename/); assert.deepEqual(f.lookups, []);
});
test('private-file replacement during open is refused before inspection', () => {
  const f = fixture(); f.expire(); const original = f.deps.files.openSync;
  f.deps.files.openSync = (name, ...args) => {
    const fd = original(name, ...args); if (name === file) f.patch(file, { ino: 88 }); return fd;
  };
  noActions(f); assert.deepEqual(f.lookups, []);
});
test('target file disappearance during protected read does not mean an empty list', () => {
  const f = fixture(); f.expire(); f.targets(); const original = f.deps.files.openSync;
  f.deps.files.openSync = (name, ...args) => {
    if (name === targetFile) { f.nodes.delete(targetFile); throw absent(); }
    return original(name, ...args);
  };
  noActions(f); assert.deepEqual(f.lookups, []);
});
test('in-place private-file mutation during read fails closed', () => {
  const f = fixture(); f.expire(); const original = f.deps.files.readFileSync;
  f.deps.files.readFileSync = fd => {
    const result = original(fd); f.patch(file, { mtimeMs: 1 }); return result;
  };
  noActions(f); assert.deepEqual(f.lookups, []);
});
test('owner resurrection during the last target inspection blocks signal', () => {
  const f = fixture(); f.expire(); let inspections = 0;
  f.hook = pid => { if (pid === 202 && ++inspections === 3) f.processes.set(200, start); };
  noActions(f, /owner is alive/);
});
test('invalid apply values cannot produce side effects', () => {
  const f = fixture(); assert.throws(() => audit({ apply: 'yes' }, f.deps), /boolean/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
});
test('controller fields are pinned and audited as an explicit target', () => {
  const f = fixture({ controller: true });
  const stored = JSON.parse(f.nodes.get(file).text).manifest;
  assert.equal(stored.controllerPid, 204); assert.equal(stored.controllerIdentity, start);
  f.expire(); f.targets();
  const dry = f.run(false);
  assert.deepEqual(dry.tasks[0].candidates, [202, 204, 203]);
  assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, []);
  const report = f.run();
  assert.deepEqual(f.signals, [[202, 'SIGTERM'], [204, 'SIGTERM'], [203, 'SIGTERM']]);
  assert.deepEqual(report.tasks[0].remaining, [202, 204, 203]);
});
for (const [label, change] of [
  ['missing controller identity', f => f.json(manifestFile, m => { delete m.controllerIdentity; })],
  ['missing controller PID', f => f.json(manifestFile, m => { delete m.controllerPid; })],
  ['null controller pair', f => f.json(manifestFile, m => { m.controllerPid = null; m.controllerIdentity = null; })],
  ['controller UID mismatch', f => f.json(manifestFile, m => { m.controllerIdentity = start.replace('501', '502'); })],
  ['controller overlapping owner', f => f.json(manifestFile, m => { m.controllerPid = 200; })],
  ['controller overlapping supervisor', f => f.json(manifestFile, m => { m.controllerPid = 201; })],
  ['controller overlapping server', f => f.json(manifestFile, m => { m.controllerPid = 202; })],
  ['dead controller', f => f.processes.delete(204)],
  ['reused controller', f => f.processes.set(204, reused)],
]) test(`registration refuses ${label} without mutation`, () => {
  const f = fixture({ registered: false, controller: true }); change(f);
  assert.throws(() => f.register()); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
});
for (const [label, change] of [
  ['removed controller fields', f => f.json(manifestFile, m => { delete m.controllerPid; delete m.controllerIdentity; })],
  ['changed controller PID', f => f.json(manifestFile, m => { m.controllerPid = 205; })],
  ['changed controller identity', f => f.json(manifestFile, m => { m.controllerIdentity = reused; })],
  ['reused controller PID', f => f.processes.set(204, reused)],
  ['controller repeated in targets', f => f.targets([{ pid: 204, identity: start }])],
  ['controller names audit process', f => { f.deps.selfPid = 204; }],
]) test(`audit refuses ${label} without actions`, () => {
  const f = fixture({ controller: true }); f.expire(); change(f); noActions(f);
});
test('controller added after registration is not a trusted dynamic target', () => {
  const f = fixture(); f.expire();
  f.json(manifestFile, m => { m.controllerPid = 204; m.controllerIdentity = start; });
  noActions(f, /immutable manifest fields changed/);
});
test('controller PID reuse between snapshot and signals blocks the whole task', () => {
  const f = fixture({ controller: true }); f.expire(); let inspections = 0;
  f.hook = pid => { if (pid === 204 && ++inspections === 2) f.processes.set(204, reused); };
  noActions(f); assert.equal(inspections, 2);
});
test('live controller prevents completion even when server and socket are gone', () => {
  const f = fixture({ controller: true }); f.expire(); f.processes.delete(202); f.nodes.delete(socketFile);
  const report = f.run();
  assert.deepEqual(f.signals, [[204, 'SIGTERM']]); onlyStateWrites(f);
  assert.equal(report.tasks[0].status, 'retained'); assert.equal(report.tasks[0].registeredProcessesGone, false);
});
test('completion requires the registered controller identity to be absent', () => {
  const f = fixture({ controller: true }); f.expire();
  f.processes.delete(202); f.processes.delete(204); f.nodes.delete(socketFile);
  const report = f.run(); assert.equal(report.tasks[0].status, 'completed');
  assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, [['unlink', file]]);
});
function stoppedFixture({ controller = true } = {}) {
  const f = fixture({ controller }); f.targets();
  for (const pid of [202, 203, 204]) f.processes.delete(pid);
  f.nodes.delete(socketFile);
  f.put(`${root}/stopped`, 'file', 0o600, JSON.stringify({ root, clean: true,
    cleanupScope: 'server-and-registered-targets-only', unknownSelfDetachingChildren: 'unresolved' }));
  f.reset(); return f;
}
function refuseComplete(f, reason) {
  assert.throws(() => f.complete(), reason); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
  assert(f.nodes.has(file), 'failed completion must preserve the registry');
}
test('live owner completes before deadline and removes only matching registry', () => {
  const f = stoppedFixture();
  const otherId = 'f'.repeat(32), otherFile = `${registry}/${otherId}.json`;
  const other = JSON.parse(f.nodes.get(file).text); other.id = otherId; other.manifest.root = '/private/tmp/ag-rex-tests-other';
  f.put(otherFile, 'file', 0o600, JSON.stringify(other));
  const before = new Map([...f.nodes].map(([p, n]) => [p, JSON.stringify(n)]));
  const report = f.complete(); assert.equal(report.status, 'completed'); assert.equal(report.id, nonce);
  assert.equal(report.unknownSelfDetachingChildren, 'unresolved');
  assert.deepEqual(f.mutations, [['unlink', file]]); assert.deepEqual(f.signals, []);
  for (const [p, value] of before) if (p !== file) assert.equal(JSON.stringify(f.nodes.get(p)), value);
});
test('live supervisor can complete after deadline with dead owner', () => {
  const f = stoppedFixture(); f.now = deadline + 1; f.deps.selfPid = 201; f.processes.delete(200);
  assert.equal(f.complete().status, 'completed'); assert.deepEqual(f.mutations, [['unlink', file]]);
});
test('completion without an optional controller still verifies targets', () => {
  const f = stoppedFixture({ controller: false }); assert.equal(f.complete().status, 'completed');
  assert.deepEqual(f.mutations, [['unlink', file]]);
});
for (const [label, change] of [
  ['false clean', f => f.json(`${root}/stopped`, r => { r.clean = false; })],
  ['truthy nonboolean clean', f => f.json(`${root}/stopped`, r => { r.clean = 'true'; })],
  ['wrong stopped scope', f => f.json(`${root}/stopped`, r => { r.cleanupScope = 'all-children'; })],
  ['wrong stopped root', f => f.json(`${root}/stopped`, r => { r.root = '/private/tmp/ag-rex-tests-other'; })],
  ['missing stopped report', f => f.nodes.delete(`${root}/stopped`)],
  ['stopped symlink', f => f.patch(`${root}/stopped`, { type: 'symlink' })],
  ['stopped public mode', f => f.patch(`${root}/stopped`, { mode: 0o644 })],
  ['stopped foreign UID', f => f.patch(`${root}/stopped`, { uid: uid + 1 })],
  ['stopped hard link', f => f.patch(`${root}/stopped`, { nlink: 2 })],
  ['corrupt stopped report', f => f.patch(`${root}/stopped`, { text: 'null' })],
  ['surviving server', f => f.processes.set(202, start)],
  ['surviving target', f => f.processes.set(203, start)],
  ['surviving controller', f => f.processes.set(204, start)],
  ['reused server PID', f => f.processes.set(202, reused)],
  ['reused target PID', f => f.processes.set(203, reused)],
  ['reused controller PID', f => f.processes.set(204, reused)],
  ['foreign caller', f => { f.deps.selfPid = 900; f.processes.set(900, start); }],
  ['controller as caller', f => { f.deps.selfPid = 204; f.processes.set(204, start); }],
  ['dead caller', f => f.processes.delete(200)],
  ['reused caller PID', f => f.processes.set(200, reused)],
  ['root inode changed', f => f.patch(root, { ino: 88 })],
  ['root mode changed', f => f.patch(root, { mode: 0o755 })],
  ['root symlink', f => f.patch(root, { type: 'symlink' })],
  ['manifest instance changed', f => f.json(manifestFile, m => { m.instanceId = 'other'; })],
  ['manifest socket identity changed', f => f.json(manifestFile, m => { m.socketIdentity.ino++; })],
  ['manifest owner identity changed', f => f.json(manifestFile, m => { m.ownerIdentity = reused; })],
  ['manifest deadline changed', f => f.json(manifestFile, m => { m.deadline--; })],
  ['manifest controller fields removed', f => f.json(manifestFile, m => { delete m.controllerPid; delete m.controllerIdentity; })],
  ['manifest private file symlink', f => f.patch(manifestFile, { type: 'symlink' })],
  ['manifest shared endpoint', f => f.json(manifestFile, m => { m.endpoint = 'unix:///tmp/shared.sock'; })],
  ['lingering pinned socket', f => { f.put(socketFile, 'socket'); f.patch(socketFile, { ino: 4 }); }],
  ['replacement socket', f => f.put(socketFile, 'socket')],
  ['socket symlink', f => f.put(socketFile, 'symlink')],
  ['registry symlink', f => f.patch(file, { type: 'symlink' })],
  ['registry foreign UID', f => f.patch(file, { uid: uid + 1 })],
  ['registry public file', f => f.patch(file, { mode: 0o644 })],
  ['registry wrong version', f => f.json(file, r => { r.version = 2; })],
  ['registry corrupt file', f => f.patch(file, { text: '{' })],
  ['registry wrong root inode', f => f.json(file, r => { r.rootIdentity.ino++; })],
  ['registry manifest changed', f => f.json(file, r => { r.manifest.instanceId = 'other'; })],
  ['registry directory mode changed', f => f.patch(registry, { mode: 0o755 })],
  ['target list corrupt', f => f.patch(targetFile, { text: 'null' })],
  ['ps unavailable', f => { f.hook = () => { throw new Error('ps failed'); }; }],
]) test(`complete refuses ${label} without actions`, () => {
  const f = stoppedFixture(); change(f); refuseComplete(f);
});
test('normal endpoint and missing registration cannot authorize completion', () => {
  const f = fixture({ registered: false });
  assert.throws(() => f.complete(), /absent/); assert.deepEqual(f.mutations, []);
  assert.throws(() => complete('/Users/fixture/.config/rex', f.deps), /private Rex test root/);
  assert.deepEqual(f.signals, []);
});
test('duplicate registrations cannot authorize deletion', () => {
  const f = stoppedFixture(), id = 'a'.repeat(32);
  const duplicate = JSON.parse(f.nodes.get(file).text); duplicate.id = id;
  f.put(`${registry}/${id}.json`, 'file', 0o600, JSON.stringify(duplicate));
  refuseComplete(f, /one matching registry/);
});
for (const [label, change] of [
  ['root replacement', f => f.patch(root, { ino: 88 })],
  ['registry inode replacement', f => f.patch(file, { ino: 88 })],
  ['registry directory replacement', f => f.patch(registry, { ino: 88 })],
  ['registry content changed', f => f.json(file, r => { r.extra = true; })],
  ['manifest changed', f => f.json(manifestFile, m => { m.instanceId = 'changed'; })],
  ['socket returned', f => f.put(socketFile, 'socket')],
  ['targets changed', f => f.targets([])],
  ['stopped report replaced', f => f.patch(`${root}/stopped`, { ino: 88 })],
  ['stopped report changed', f => f.json(`${root}/stopped`, r => { r.clean = false; })],
  ['caller exited', f => f.processes.delete(200)],
]) test(`completion reread refuses ${label}`, () => {
  const f = stoppedFixture(); let fired = false;
  f.hook = (_pid, n) => { if (n === 3) { fired = true; change(f); } };
  refuseComplete(f); assert(fired);
});
test('registry replacement between matching lookup and proof is refused', () => {
  const f = stoppedFixture(), original = f.deps.files.openSync; let opens = 0;
  f.deps.files.openSync = (name, ...args) => {
    if (name === file && ++opens === 2) f.patch(file, { ino: 88 });
    return original(name, ...args);
  };
  refuseComplete(f, /private file replaced|registry record changed/);
});
test('registered survivor appearing before final pass blocks completion', () => {
  const f = stoppedFixture(); let inspections = 0;
  f.hook = pid => { if (pid === 202 && ++inspections === 2) f.processes.set(203, start); };
  refuseComplete(f, /still alive/); assert.equal(inspections, 2);
});
test('missing matching registry record is not successful completion', () => {
  const f = stoppedFixture();
  f.json(file, r => { r.manifest.root = '/private/tmp/ag-rex-tests-other'; });
  refuseComplete(f, /one matching registry/);
});
test('final registry reread refuses a file replaced at the last open', () => {
  const f = stoppedFixture(), original = f.deps.files.openSync; let opens = 0;
  // Lookup, initial proof, and two storage passes each read the record.
  // The eighth read is the last proof immediately before unlink.
  f.deps.files.openSync = (name, ...args) => {
    if (name === file && ++opens === 8) f.patch(file, { ino: 88 });
    return original(name, ...args);
  };
  refuseComplete(f, /private file replaced|registry record changed/); assert.equal(opens, 8);
});
test('normal completion evidence does not let dry audit write or deregister', () => {
  const f = stoppedFixture(), before = JSON.stringify([...f.nodes]);
  const result = f.run(false); assert.equal(result.tasks[0].status, 'skipped');
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
  assert.equal(JSON.stringify([...f.nodes]), before);
});
function termedFixture() {
  const f = fixture(); f.expire(); f.targets(); f.run();
  assert.deepEqual(f.signals, [[202, 'SIGTERM'], [203, 'SIGTERM']]);
  const state = JSON.parse(f.nodes.get(escalationFile).text);
  assert.equal(f.nodes.get(escalationFile).mode, 0o600);
  assert.deepEqual(state.targets.map(t => [t.pid, t.identity, t.termAt, t.killAt]),
    [[202, start, deadline, null], [203, start, deadline, null]]);
  f.signals.length = 0; f.reset(); return f;
}
test('persistent TERM state allows KILL only after ten seconds in a later call', () => {
  const f = termedFixture(); f.now = deadline + grace - 1; f.run();
  assert.deepEqual(f.signals, []); onlyStateWrites(f);
  f.reset(); f.now = deadline + grace; const report = f.run();
  assert.deepEqual(f.signals, [[202, 'SIGKILL'], [203, 'SIGKILL']]);
  assert.deepEqual(report.tasks[0].signalDetails, [{ pid: 202, signal: 'SIGKILL' }, { pid: 203, signal: 'SIGKILL' }]);
  onlyStateWrites(f);
  const s = JSON.parse(f.nodes.get(escalationFile).text);
  assert.deepEqual(s.targets.map(t => t.killAt), [deadline + grace, deadline + grace]);
});
test('repeat applies never repeat TERM or a successful KILL', () => {
  const f = termedFixture(); f.run(); assert.deepEqual(f.signals, []); assert.deepEqual(f.mutations, []);
  f.now = deadline + grace; f.run(); f.signals.length = 0; f.reset();
  f.now = deadline + 2 * grace; f.run(); assert.deepEqual(f.signals, []); onlyStateWrites(f);
});
test('failed TERM never creates escalation authority or later KILL', () => {
  const f = fixture(); f.expire(); f.targets();
  f.signalHook = () => { throw new Error('TERM failed'); }; f.run();
  assert(!f.nodes.has(escalationFile)); assert.deepEqual(f.mutations, []);
  f.now = deadline + 3 * grace; f.signalHook = () => {}; f.signals.length = 0; f.reset(); f.run();
  assert.deepEqual(f.signals, [[202, 'SIGTERM'], [203, 'SIGTERM']]);
  assert(JSON.parse(f.nodes.get(escalationFile).text).targets.every(t => t.killAt === null));
});
test('one successful TERM cannot authorize KILL for a failed target TERM', () => {
  const f = fixture(); f.expire(); f.targets();
  f.signalHook = pid => { if (pid === 203) throw new Error('target TERM failed'); };
  f.run();
  assert.deepEqual(JSON.parse(f.nodes.get(escalationFile).text).targets.map(t => t.pid), [202]);
  f.signals.length = 0; f.reset(); f.now = deadline + grace; f.signalHook = () => {}; f.run();
  assert.deepEqual(f.signals, [[202, 'SIGKILL'], [203, 'SIGTERM']]);
});
test('explicit controller can escalate but unknown children are never inspected', () => {
  const f = fixture({ controller: true }); f.expire(); f.targets(); f.processes.set(700, start);
  f.run(); f.signals.length = 0; f.reset(); f.now = deadline + grace; f.run();
  assert.deepEqual(f.signals, [[202, 'SIGKILL'], [204, 'SIGKILL'], [203, 'SIGKILL']]);
  assert(!f.lookups.includes(700)); assert(f.signals.every(([pid]) => pid > 1));
});
test('false signal result and ESRCH never record TERM success', () => {
  for (const kind of ['false', 'ESRCH']) {
    const f = fixture(); f.expire();
    f.deps.signal = () => { if (kind === 'false') return false; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    f.run(); assert(!f.nodes.has(escalationFile)); assert.deepEqual(f.mutations, []);
  }
});
test('failed KILL retains TERM state but does not record KILL success', () => {
  const f = termedFixture(); f.now = deadline + grace;
  f.signalHook = () => { throw new Error('KILL failed'); }; f.run();
  assert.deepEqual(f.signals, [[202, 'SIGKILL']]); assert.deepEqual(f.mutations, []);
  assert(JSON.parse(f.nodes.get(escalationFile).text).targets.every(t => t.killAt === null));
  f.signalHook = () => {}; f.signals.length = 0; f.run();
  assert.deepEqual(f.signals, [[202, 'SIGKILL'], [203, 'SIGKILL']]);
});
test('failed state persistence cannot authorize KILL', () => {
  const f = fixture(); f.expire(); f.targets();
  f.deps.files.fsyncSync = () => { throw new Error('fsync failed'); }; f.run();
  assert(!f.nodes.has(escalationFile)); assert.deepEqual(f.signals, [[202, 'SIGTERM']]);
  f.signals.length = 0; f.reset(); f.now = deadline + grace; f.run();
  assert(!f.signals.some(([, sig]) => sig === 'SIGKILL'));
});
for (const [label, change] of [
  ['server PID reuse', f => f.processes.set(202, reused)],
  ['target PID reuse', f => f.processes.set(203, reused)],
  ['root inode changed', f => f.patch(root, { ino: 88 })],
  ['socket inode changed', f => f.patch(socketFile, { ino: 88 })],
  ['socket symlink', f => f.patch(socketFile, { type: 'symlink' })],
  ['live owner', f => f.processes.set(200, start)],
  ['live supervisor', f => f.processes.set(201, start)],
  ['registry inode replaced', f => f.patch(file, { ino: 88 })],
  ['registry content changed', f => f.json(file, r => { r.extra = true; })],
  ['registered target list changed', f => f.targets([])],
  ['registered targets disappeared', f => f.nodes.delete(targetFile)],
  ['manifest changed', f => f.json(manifestFile, m => { m.instanceId = 'other'; })],
  ['escalation corrupt', f => f.patch(escalationFile, { text: '{}' })],
  ['escalation public mode', f => f.patch(escalationFile, { mode: 0o644 })],
  ['escalation foreign UID', f => f.patch(escalationFile, { uid: uid + 1 })],
  ['escalation symlink', f => f.patch(escalationFile, { type: 'symlink' })],
  ['escalation hard link', f => f.patch(escalationFile, { nlink: 2 })],
  ['escalation target identity changed', f => f.json(escalationFile, s => { s.targets[0].identity = reused; })],
  ['escalation binding changed', f => f.json(escalationFile, s => { s.binding = 'other'; })],
  ['escalation time malformed', f => f.json(escalationFile, s => { s.targets[0].termAt = 'old'; })],
]) test(`escalation refuses ${label} without signals or writes`, () => {
  const f = termedFixture(); f.now = deadline + grace; change(f); noActions(f);
});
for (const [label, change] of [
  ['PID reuse', f => f.processes.set(202, reused)],
  ['root replacement', f => f.patch(root, { ino: 88 })],
  ['socket replacement', f => f.patch(socketFile, { ino: 88 })],
  ['owner resurrection', f => f.processes.set(200, start)],
  ['registry replacement', f => f.patch(file, { ino: 88 })],
  ['targets change', f => f.targets([])],
  ['escalation replacement', f => f.patch(escalationFile, { ino: 88 })],
  ['clock rollback', f => { f.now = deadline - 1; }],
]) test(`fresh KILL reread refuses ${label}`, () => {
  const f = termedFixture(); f.now = deadline + grace; let fired = false;
  f.hook = (_pid, n) => { if (n === 5) { fired = true; change(f); } };
  noActions(f); assert(fired);
});
test('backward clock is refused even after an incomplete grace observation', () => {
  const f = termedFixture(); f.now = deadline + grace - 1; f.run(); f.reset();
  f.now = deadline + 1; noActions(f, /clock moved backward/);
});
test('a clock change at the final KILL decision prevents signaling', () => {
  const f = termedFixture(); let checks = 0;
  f.deps.clock = () => ++checks >= 6 ? deadline : deadline + grace;
  // Reset in a process check so the final signal clock sees a rollback.
  f.hook = pid => { if (pid === 202 && f.lookups.filter(p => p === 202).length === 3) checks = 6; };
  noActions(f);
});
test('dry audit after TERM and after KILL has zero signals and writes', () => {
  const f = termedFixture(); f.now = deadline + grace;
  const before = JSON.stringify([...f.nodes]); f.run(false);
  assert.equal(JSON.stringify([...f.nodes]), before); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
  f.run(); f.signals.length = 0; f.reset(); f.now = deadline + 2 * grace;
  const killed = JSON.stringify([...f.nodes]); f.run(false);
  assert.equal(JSON.stringify([...f.nodes]), killed); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
});
test('KILL completion removes state and registry only after exit proof', () => {
  const f = termedFixture(); f.now = deadline + grace;
  f.signalHook = pid => { f.processes.delete(pid); if (pid === 202) f.nodes.delete(socketFile); };
  assert.equal(f.run().tasks[0].status, 'completed');
  assert.deepEqual(f.signals, [[202, 'SIGKILL'], [203, 'SIGKILL']]);
  assert.deepEqual(f.mutations.filter(m => m[0] === 'unlink'), [['unlink', escalationFile], ['unlink', file]]);
  assert(f.nodes.has(root)); assert(f.nodes.has(targetFile));
});
test('complete removes escalation state only after its normal success proof', () => {
  const f = termedFixture(); f.processes.set(200, start); f.deps.selfPid = 200;
  f.processes.delete(202); f.processes.delete(203); f.nodes.delete(socketFile);
  f.put(`${root}/stopped`, 'file', 0o600, JSON.stringify({ root, clean: false, cleanupScope: 'server-and-registered-targets-only' }));
  refuseComplete(f); assert(f.nodes.has(escalationFile));
  f.json(`${root}/stopped`, r => { r.clean = true; });
  assert.equal(f.complete().status, 'completed');
  assert.deepEqual(f.mutations, [['unlink', escalationFile], ['unlink', file]]); assert.deepEqual(f.signals, []);
});
test('complete preserves a replaced escalation record', () => {
  const f = termedFixture(); f.processes.set(200, start); f.deps.selfPid = 200;
  f.processes.delete(202); f.processes.delete(203); f.nodes.delete(socketFile);
  f.put(`${root}/stopped`, 'file', 0o600, JSON.stringify({ root, clean: true, cleanupScope: 'server-and-registered-targets-only' }));
  f.hook = (_pid, n) => { if (n === 3) f.patch(escalationFile, { ino: 88 }); };
  refuseComplete(f); assert(f.nodes.has(escalationFile));
});
function snapshotFixture() {
  const f = stoppedFixture(); let calls = 0, hook = () => {};
  const text = () => [...f.processes].map(([pid, value]) => ` ${pid} ${value}\n`).join('');
  f.deps.psSnapshot = () => { calls++; return hook(calls) ?? text(); };
  return { f, get calls() { return calls; }, set hook(value) { hook = value; }, text };
}
test('completion uses exactly two fresh snapshots and retains direct caller checks', () => {
  const s = snapshotFixture(), f = s.f;
  assert.equal(f.complete().status, 'completed'); assert.equal(s.calls, 2);
  assert.deepEqual(f.lookups, [200, 200, 200, 200, 200]);
  assert.deepEqual(f.mutations, [['unlink', file]]); assert.deepEqual(f.signals, []);
});
test('snapshot completion accepts normalized ps spacing and unrelated negative UIDs', () => {
  const s = snapshotFixture();
  s.hook = () => s.text().replaceAll(' ', '  ') + ' 321 -2 Tue Nov 10  12:34:56 2026\n';
  assert.equal(s.f.complete().status, 'completed'); assert.equal(s.calls, 2);
});
for (const [label, text] of [
  ['nonstring', () => new Map()],
  ['empty', () => ''],
  ['truncated output', s => s.text().trimEnd()],
  ['truncated identity', s => s.text() + '999 501 Mon Nov 9\n'],
  ['invalid start time', s => s.text() + '999 501 Mon Nov 9 25:00:00 2026\n'],
  ['nonnumeric UID', s => s.text() + '999 unknown Mon Nov 9 12:34:56 2026\n'],
  ['unsafe PID', s => s.text() + '9007199254740993 501 Mon Nov 9 12:34:56 2026\n'],
  ['duplicate PID', s => s.text() + `200 ${start}\n`],
  ['header row', s => 'PID UID STARTED\n' + s.text()],
  ['blank interior row', s => s.text() + '\n999 501 Mon Nov 9 12:34:56 2026\n'],
  ['missing caller row', () => `201 ${start}\n`],
  ['reused caller', s => s.text().replace(`200 ${start}`, `200 ${reused}`)],
  ['foreign caller UID', s => s.text().replace(`200 ${uid}`, '200 502')],
  ['live server', s => s.text() + `202 ${start}\n`],
  ['reused server', s => s.text() + `202 ${reused}\n`],
  ['live target', s => s.text() + `203 ${start}\n`],
  ['reused target', s => s.text() + `203 ${reused}\n`],
  ['live controller', s => s.text() + `204 ${start}\n`],
  ['reused controller', s => s.text() + `204 ${reused}\n`],
]) test(`completion snapshot refuses ${label} without unlink`, () => {
  const s = snapshotFixture(); s.hook = () => text(s); refuseComplete(s.f); assert.equal(s.calls, 1);
});
test('a fresh second snapshot rejects a target that appeared between passes', () => {
  const s = snapshotFixture(); s.hook = n => s.text() + (n === 2 ? `203 ${reused}\n` : '');
  refuseComplete(s.f, /PID was reused/); assert.equal(s.calls, 2);
});
test('caller reused between snapshot passes blocks completion', () => {
  const s = snapshotFixture(); s.hook = n => n === 2 ? s.text().replace(`200 ${start}`, `200 ${reused}`) : s.text();
  refuseComplete(s.f, /PID was reused/); assert.equal(s.calls, 2);
});
test('malformed second snapshot is not masked by a valid first snapshot', () => {
  const s = snapshotFixture(); s.hook = n => n === 2 ? 'bad\n' : s.text();
  refuseComplete(s.f, /snapshot/); assert.equal(s.calls, 2);
});
for (const [label, change] of [
  ['root inode', f => f.patch(root, { ino: 88 })],
  ['registry inode', f => f.patch(file, { ino: 88 })],
  ['manifest identity', f => f.json(manifestFile, m => { m.instanceId = 'different'; })],
  ['socket return', f => f.put(socketFile, 'socket')],
  ['target list', f => f.targets([])],
  ['stopped proof', f => f.json(`${root}/stopped`, r => { r.clean = false; })],
  ['immediate caller identity', f => f.processes.set(200, reused)],
]) test(`storage and caller rereads after snapshots reject changed ${label}`, () => {
  const s = snapshotFixture(); s.hook = n => {
    const captured = s.text(); if (n === 2) change(s.f); return captured;
  };
  refuseComplete(s.f); assert.equal(s.calls, 2);
});
test('snapshot inspection failure is not treated as target absence', () => {
  const s = snapshotFixture(); s.hook = () => { throw new Error('ps snapshot failed'); };
  refuseComplete(s.f, /snapshot failed/);
});
test('audit never uses completion snapshots for signal decisions', () => {
  const f = fixture(); f.expire(); f.targets();
  f.deps.psSnapshot = () => { assert.fail('audit used a completion snapshot'); };
  f.run(); assert.deepEqual(f.signals, [[202, 'SIGTERM'], [203, 'SIGTERM']]);
});
test('fourteen-target proof reduces per-PID inspections without changing caller checks', () => {
  const targets = Array.from({ length: 14 }, (_, i) => ({ pid: 300 + i, identity: start }));
  const legacy = stoppedFixture(); legacy.targets(targets); legacy.complete();
  const s = snapshotFixture(); s.f.targets(targets); s.f.complete();
  assert.equal(legacy.lookups.length, 37); assert.equal(s.f.lookups.length, 5); assert.equal(s.calls, 2);
  console.log(`MEASURE 14 targets: completion inspections ${legacy.lookups.length} per-PID calls -> ${s.f.lookups.length} per-PID calls + ${s.calls} fresh snapshots`);
});
for (const [label, change] of [
  ['root identity changed', f => f.patch(root, { ino: 88 })],
  ['owner changed', f => {
    f.json(manifestFile, m => { m.ownerPid = 210; m.ownerIdentity = reused; });
    f.processes.set(210, reused); f.deps.selfPid = 210;
  }],
  ['instance changed', f => f.json(manifestFile, m => { m.instanceId = 'different'; })],
]) test(`conflicting registration refuses ${label} without another record`, () => {
  const f = fixture(); f.deps.nonce = () => 'e'.repeat(32); change(f);
  assert.throws(() => f.register()); assert.deepEqual(f.mutations, []);
  assert.equal([...f.nodes.keys()].filter(name => /^[a-f0-9]{32}\.json$/.test(path.basename(name))).length, 1);
});
test('different root cannot overwrite an existing nonce registration', () => {
  const f = fixture(), otherRoot = '/private/tmp/ag-rex-tests-other', original = f.nodes.get(file).text;
  const m = manifest(); m.root = otherRoot; m.endpoint = `unix://${otherRoot}/server.sock`;
  f.put(otherRoot, 'directory', 0o700); f.put(`${otherRoot}/manifest.json`, 'file', 0o600, JSON.stringify(m));
  f.put(`${otherRoot}/server.sock`, 'socket'); f.patch(`${otherRoot}/server.sock`, { ino: 4 });
  assert.throws(() => register(otherRoot, f.deps), /exists/);
  assert.equal(f.nodes.get(file).text, original);
  assert.equal([...f.nodes.keys()].filter(name => /^[a-f0-9]{32}\.json$/.test(path.basename(name))).length, 1);
});
test('atomic pending root claim prevents another registrar without removing its claim', () => {
  const f = fixture({ registered: false }); f.put(registry, 'directory', 0o700);
  f.put(claimFile, 'file', 0o600, JSON.stringify({ root, rootIdentity: { dev: 1, ino: 2 } }));
  const before = f.nodes.get(claimFile).text;
  assert.throws(() => f.register(), /exists/); assert.equal(f.nodes.get(claimFile).text, before);
  assert(!f.nodes.has(file)); assert(!f.mutations.some(m => m[0] === 'unlink'));
});
test('nested competing registration loses the root claim and publishes no duplicate', () => {
  const f = fixture({ registered: false }), open = f.deps.files.openSync; let attempted = false;
  f.deps.files.openSync = (name, ...args) => {
    const fd = open(name, ...args);
    if (name === claimFile && !attempted) {
      attempted = true; const other = { ...f.deps, nonce: () => 'e'.repeat(32) };
      assert.throws(() => register(root, other), /exists/);
    }
    return fd;
  };
  f.register(); assert(attempted); assert(!f.nodes.has(claimFile));
  assert.equal([...f.nodes.keys()].filter(name => /^[a-f0-9]{32}\.json$/.test(path.basename(name))).length, 1);
});
test('failed registration publication releases only its own root claim', () => {
  const f = fixture({ registered: false }); const original = f.deps.files.writeFileSync;
  let writes = 0;
  f.deps.files.writeFileSync = (fd, text) => { if (++writes === 2) throw new Error('registration write failed'); original(fd, text); };
  assert.throws(() => f.register(), /registration write failed/);
  assert(!f.nodes.has(claimFile)); assert.deepEqual(f.mutations.filter(m => m[0] === 'unlink'), [['unlink', claimFile]]);
});
for (const [label, change] of [
  ['not expired', f => { f.now = deadline - 1; }],
  ['live owner', f => f.processes.set(200, start)],
  ['live supervisor', f => f.processes.set(201, start)],
]) test(`audit reports expected ${label} skip without failure`, () => {
  const f = fixture(); f.expire(); change(f); const r = noActions(f);
  assert.equal(r.failed, 0); assert.equal(r.tasks[0].failed, false); assert.equal(auditFailed(r), false);
});
test('incomplete escalation grace is not an operational failure', () => {
  const f = termedFixture(); f.now = deadline + grace - 1;
  const r = f.run(); assert.equal(r.failed, 0); assert.equal(auditFailed(r), false); assert.deepEqual(f.signals, []);
});
for (const [label, change] of [
  ['failed TERM', f => { f.signalHook = () => { throw new Error('TERM failed'); }; }],
  ['inspection failure', f => { f.hook = () => { throw new Error('ps failed'); }; }],
  ['escalation persistence failure', f => { f.deps.files.fsyncSync = () => { throw new Error('fsync failed'); }; }],
  ['corrupt metadata', f => f.patch(file, { text: 'null' })],
  ['PID reuse', f => f.processes.set(202, reused)],
  ['replaced root', f => f.patch(root, { ino: 88 })],
  ['replaced socket', f => f.patch(socketFile, { ino: 88 })],
]) test(`audit marks ${label} as operational failure`, () => {
  const f = fixture(); f.expire(); change(f); const r = f.run();
  assert.equal(r.failed, 1); assert.equal(r.tasks[0].failed, true); assert.equal(auditFailed(r), true);
});
test('one task failure is counted independently from expected task skips', () => {
  const f = fixture(); const id = 'a'.repeat(32);
  f.put(`${registry}/${id}.json`, 'file', 0o600, '{}');
  const r = f.run(false); assert.equal(r.failed, 1); assert.equal(r.tasks.length, 2);
  assert.equal(r.tasks.filter(t => t.failed).length, 1); assert.deepEqual(f.mutations, []);
});
test('owner resurrection after an initial proof remains an expected skip', () => {
  const f = fixture(); f.expire(); f.targets();
  f.hook = (_pid, n) => { if (n === 5) f.processes.set(200, start); };
  const r = noActions(f, /owner is alive/); assert.equal(r.failed, 0); assert.equal(auditFailed(r), false);
});
test('live owner PID reuse is an operational identity failure, not an expected skip', () => {
  const f = fixture(); f.expire(); f.processes.set(200, reused);
  const r = noActions(f, /PID was reused/); assert.equal(r.failed, 1); assert(auditFailed(r));
});
test('dry audit marks unsafe metadata failed without writing', () => {
  const f = fixture(); f.expire(); f.patch(file, { text: '{}' }); const r = f.run(false);
  assert.equal(r.failed, 1); assert(auditFailed(r)); assert.deepEqual(f.mutations, []); assert.deepEqual(f.signals, []);
});
test('registry access failure is counted outside task processing', () => {
  const f = fixture(); f.patch(registry, { mode: 0o777 }); const r = f.run(false);
  assert.equal(r.failed, 1); assert.equal(r.tasks.length, 0); assert.equal(r.errors.length, 1); assert(auditFailed(r));
});
test('failed KILL is counted and missing reports fail conservative integration', () => {
  const f = termedFixture(); f.now = deadline + grace; f.signalHook = () => { throw new Error('KILL failed'); };
  assert.equal(f.run().failed, 1);
  for (const r of [null, {}, { failed: -1 }, { failed: '0' }]) assert.equal(auditFailed(r), true);
  assert.equal(auditFailed({ failed: 0 }), false);
});
const engineUrl = new URL('../macos/.local/bin/reap-rex-tests.mjs', import.meta.url);
function cliFixture(f, args) {
  // Execute the exact standalone dispatch with injected OS adapters. No child
  // process, real registry, ps call, or signal runs in this CLI exit-code test.
  const source = fs.readFileSync(engineUrl, 'utf8').replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '').replaceAll('import.meta.url', 'engineUrl');
  const output = [], processStub = { argv: ['node', fileURLToPath(engineUrl), ...args],
    pid: f.deps.selfPid, getuid: () => uid, kill: f.deps.signal, exitCode: 0 };
  runInNewContext(source, { fs: f.deps.files, os: { ...os, homedir: () => home }, path,
    randomBytes, createHash, fileURLToPath, engineUrl, Buffer, structuredClone,
    Date: { now: () => deadline }, process: processStub,
    spawnSync: (_binary, argv) => {
      const pid = Number(argv[1]), value = f.deps.ps(pid);
      return { status: value === null ? 1 : 0, stdout: value === null ? '' : `${value}\n` };
    }, console: { log: text => output.push(JSON.parse(text)), error: () => {} } });
  return { code: processStub.exitCode, report: output[0] };
}
test('standalone CLI returns nonzero for operational failures, including dry malformed registry', () => {
  const f = fixture(); f.expire(); f.patch(file, { text: '{}' });
  const bad = cliFixture(f, ['--dry-run']); assert.equal(bad.code, 1); assert.equal(bad.report.failed, 1);
  const signal = fixture(); signal.expire(); signal.signalHook = () => { throw new Error('TERM failed'); };
  const failed = cliFixture(signal, ['--apply']); assert.equal(failed.code, 1); assert.equal(failed.report.failed, 1);
  const live = fixture(); live.expire(); live.processes.set(200, start);
  const skipped = cliFixture(live, []); assert.equal(skipped.code, 0); assert.equal(skipped.report.failed, 0);
});
test('standalone CLI reports inspection and persistence failures with nonzero status', () => {
  for (const kind of ['inspection', 'persistence']) {
    const f = fixture(); f.expire();
    if (kind === 'inspection') f.hook = () => { throw new Error('inspection failed'); };
    else f.deps.files.fsyncSync = () => { throw new Error('persistence failed'); };
    const r = cliFixture(f, ['--apply']); assert.equal(r.code, 1); assert.equal(r.report.failed, 1);
  }
});
console.log(`ALL PASS ${count} injected Rex registration, audit and completion tests`);
