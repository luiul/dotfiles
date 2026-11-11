#!/usr/bin/env node
/** Explicit Rex test registrations only. No server discovery or root removal.
 * Registration pins controller, endpoint and filesystem identities before work.
 * Audit reads dynamic targets only from the supervisor's private targets.json.
 * Each signal gets a fresh check of the whole registration, not just its PID.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIMIT = 1024 * 1024;
const KILL_GRACE_MS = 10_000;
const ID = /^[a-f0-9]{32}$/;
const START = /^\d+ (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
const scope = { cleanupScope: 'server-and-registered-targets-only', unknownSelfDetachingChildren: 'unresolved' };
function requireSafe(ok, message) { if (!ok) throw new Error(message); }
class Ineligible extends Error {}
function requireEligible(ok, message) { if (!ok) throw new Ineligible(message); }
function identity(value, uid) {
  requireSafe(typeof value === 'string' && START.test(value) && Number(value.split(' ')[0]) === uid, 'invalid process identity');
  return value;
}
function inspectPid(pid) {
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (!r.error && r.status === 1 && !r.stdout.trim()) return null;
  requireSafe(!r.error && r.status === 0, 'ps inspection failed');
  const value = r.stdout.trim().replace(/\s+/g, ' ');
  requireSafe(START.test(value), 'invalid ps identity');
  return value;
}
function inspectProcesses() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,uid=,lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  requireSafe(!r.error && r.status === 0, 'ps snapshot failed');
  return r.stdout;
}
function processSnapshot(text) {
  // Validate every row, including unrelated users. Some macOS services have
  // negative UIDs. They are valid rows, but never match a registered identity.
  requireSafe(typeof text === 'string' && text.length > 0 && text.endsWith('\n') &&
    Buffer.byteLength(text) <= 16 * 1024 * 1024, 'invalid ps snapshot');
  const result = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const fields = line.trim().replace(/\s+/g, ' ').match(/^(\d+) (-?\d+) (.+)$/);
    requireSafe(fields, 'invalid ps snapshot row');
    const processPid = Number(fields[1]), processUid = Number(fields[2]);
    requireSafe(Number.isSafeInteger(processPid) && processPid > 0 &&
      Number.isSafeInteger(processUid) && START.test(`${Math.abs(processUid)} ${fields[3]}`) &&
      !result.has(processPid), 'invalid or duplicate ps snapshot identity');
    result.set(processPid, `${processUid} ${fields[3]}`);
  }
  return result;
}
function environment(deps) {
  const home = deps.home ?? os.homedir();
  requireSafe(path.isAbsolute(home) && path.resolve(home) === home, 'invalid home');
  return { files: deps.files ?? fs, ps: deps.ps ?? inspectPid,
    // A custom per-PID adapter stays isolated from real ps unless the caller
    // also supplies psSnapshot(), which returns raw pid/uid/lstart ps text.
    psSnapshot: deps.psSnapshot ?? (deps.ps == null ? inspectProcesses : null), clock: deps.clock ?? Date.now,
    signal: deps.signal ?? ((pid, sig) => process.kill(pid, sig)), uid: deps.uid ?? process.getuid(),
    selfPid: deps.selfPid ?? process.pid, nonce: deps.nonce ?? (() => randomBytes(16).toString('hex')),
    cache: path.join(home, '.cache'), directory: path.join(home, '.cache/rex-test-tasks') };
}
function inode(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameInode(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function missing(fn) { try { return fn(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directory(e, name, mode) {
  const s = e.files.lstatSync(name);
  requireSafe(s.isDirectory() && !s.isSymbolicLink() && s.uid === e.uid, 'unsafe directory');
  requireSafe(mode === undefined ? (s.mode & 0o022) === 0 : (s.mode & 0o7777) === mode, 'unsafe directory mode');
  requireSafe(e.files.realpathSync(name) === name, 'directory path is not canonical');
  return inode(s);
}
function registry(e, create = false) {
  if (create && !missing(() => e.files.lstatSync(e.cache))) e.files.mkdirSync(e.cache, { mode: 0o700 });
  directory(e, e.cache);
  if (create && !missing(() => e.files.lstatSync(e.directory))) e.files.mkdirSync(e.directory, { mode: 0o700 });
  return directory(e, e.directory, 0o700);
}
function readPrivate(e, name) {
  const before = e.files.lstatSync(name);
  const check = s => requireSafe(s.isFile() && !s.isSymbolicLink() && s.uid === e.uid &&
    (s.mode & 0o7777) === 0o600 && s.nlink === 1 && s.size <= LIMIT, 'unsafe private file');
  check(before);
  const fd = e.files.openSync(name, e.files.constants.O_RDONLY | e.files.constants.O_NOFOLLOW | e.files.constants.O_NONBLOCK);
  try {
    const opened = e.files.fstatSync(fd); check(opened);
    requireSafe(sameInode(before, opened), 'private file replaced');
    const text = e.files.readFileSync(fd, 'utf8');
    const after = e.files.fstatSync(fd); check(after);
    const current = e.files.lstatSync(name); check(current);
    requireSafe(sameInode(opened, current) && after.size === opened.size &&
      after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      current.mtimeMs === opened.mtimeMs && current.ctimeMs === opened.ctimeMs &&
      Buffer.byteLength(text) <= LIMIT, 'private file changed');
    return { text, stat: inode(opened), value: JSON.parse(text) };
  } finally { e.files.closeSync(fd); }
}
function rootIdentity(e, root) {
  requireSafe(typeof root === 'string' && /^\/private\/tmp\/ag-rex-tests-[A-Za-z0-9_-]+$/.test(root), 'not a private Rex test root');
  return directory(e, root, 0o700);
}
function pid(value) { requireSafe(Number.isSafeInteger(value) && value > 1, 'invalid PID'); return value; }
function roles(m) {
  return ['owner', 'supervisor', 'server', ...(Object.hasOwn(m, 'controllerPid') ||
    Object.hasOwn(m, 'controllerIdentity') ? ['controller'] : [])];
}
function immutable(e, m) {
  rootIdentity(e, m.root);
  requireSafe(m.endpoint === `unix://${m.root}/server.sock`, 'not the exact private test endpoint');
  requireSafe(Number.isSafeInteger(m.deadline) && m.deadline > 0, 'invalid deadline');
  requireSafe(typeof m.instanceId === 'string' && m.instanceId.length > 0 && m.instanceId.length <= 256, 'missing server instance');
  requireSafe(m.socketIdentity && ['dev', 'ino'].every(k => Number.isSafeInteger(m.socketIdentity[k]) && m.socketIdentity[k] >= 0), 'missing socket identity');
  const result = { root: m.root, endpoint: m.endpoint, deadline: m.deadline, instanceId: m.instanceId,
    socketIdentity: inode(m.socketIdentity) };
  for (const role of roles(m)) {
    result[`${role}Pid`] = pid(m[`${role}Pid`]);
    result[`${role}Identity`] = identity(m[`${role}Identity`], e.uid);
  }
  requireSafe(new Set(roles(m).map(r => result[`${r}Pid`])).size === roles(m).length, 'controller PIDs overlap');
  return result;
}
function socket(e, m, serverDead) {
  const s = missing(() => e.files.lstatSync(path.join(m.root, 'server.sock')));
  if (!s) { requireSafe(serverDead, 'live server socket is missing'); return false; }
  requireSafe(s.isSocket() && !s.isSymbolicLink() && s.uid === e.uid && (s.mode & 0o7777) === 0o600 &&
    sameInode(s, m.socketIdentity), 'socket identity changed');
  return true;
}
function state(e, target) {
  const current = e.ps(target.pid);
  if (current === null) return 'dead';
  requireSafe(current === target.identity, 'PID was reused or identity changed');
  return 'alive';
}
function targets(e, m) {
  const file = path.join(m.root, 'targets.json');
  // Only initial absence is allowed. Disappearance during a protected read
  // must fail closed, not turn an existing target list into an empty one.
  const loaded = missing(() => e.files.lstatSync(file)) ? readPrivate(e, file) : null;
  const list = loaded ? loaded.value : [];
  requireSafe(Array.isArray(list) && list.length <= 4096, 'invalid registered targets');
  const seen = new Set([...roles(m).map(r => m[`${r}Pid`]), e.selfPid]);
  for (const t of list) {
    requireSafe(t && typeof t === 'object', 'invalid registered target');
    pid(t.pid); identity(t.identity, e.uid);
    requireSafe(!seen.has(t.pid), 'target overlaps a controller or another target');
    seen.add(t.pid);
  }
  return { text: loaded?.text ?? null, list: list.map(t => ({ pid: t.pid, identity: t.identity })) };
}
function clock(e) { const now = e.clock(); requireSafe(Number.isSafeInteger(now) && now > 0, 'invalid clock'); return now; }
function beforeWorkload(e, m) {
  requireSafe(targets(e, m).list.length === 0 && !e.files.readdirSync(m.root).some(name => name.endsWith('.target.json')),
    'register before workload');
}

/** Call after the full server manifest is saved, before ready or target execution.
 * Only a live owner or supervisor can register. Save the optional controller
 * PID and identity before this call. Adding it later invalidates registration.
 * Immutable fields are copied, not a full hash; other metadata can change.
 * Existing root registrations are refused without writes. An exclusive root
 * claim prevents two concurrent registrars from publishing different nonces.
 * The optional second argument injects files, ps, clock and signal for tests.
 */
export function register(root, deps = {}) {
  const e = environment(deps);
  const rootStat = rootIdentity(e, root);
  const m = immutable(e, readPrivate(e, path.join(root, 'manifest.json')).value);
  requireSafe(m.root === root && clock(e) < m.deadline, 'root mismatch or expired registration');
  requireSafe([m.ownerPid, m.supervisorPid].includes(e.selfPid), 'only the owner or supervisor may register');
  for (const role of roles(m)) {
    requireSafe(state(e, { pid: m[`${role}Pid`], identity: m[`${role}Identity`] }) === 'alive', 'registration process is not alive');
  }
  socket(e, m, false);
  // Readiness registration must precede any workload target publication.
  beforeWorkload(e, m);
  const registryStat = registry(e, true);
  function refuseExisting() {
    requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
    for (const name of e.files.readdirSync(e.directory)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const file = path.join(e.directory, name), loaded = readPrivate(e, file);
      if (loaded.value?.manifest?.root !== root) continue;
      const proof = readRegistration(e, file, registryStat);
      requireSafe(proof.recordText === loaded.text && sameInode(proof.recordStat, loaded.stat) &&
        JSON.stringify(proof.manifest) === JSON.stringify(m) &&
        sameInode(rootStat, rootIdentity(e, root)), 'conflicting root registration');
      throw new Error('root already registered');
    }
  }
  // Refuse a serial duplicate without writes. The exclusive claim closes the
  // scan/publish race between concurrent registrars of the same canonical root.
  refuseExisting();
  const claim = path.join(e.directory, `${createHash('sha256').update(root).digest('hex')}.registration-claim`);
  const claimFd = e.files.openSync(claim, e.files.constants.O_WRONLY | e.files.constants.O_CREAT |
    e.files.constants.O_EXCL | e.files.constants.O_NOFOLLOW, 0o600);
  const claimStat = inode(e.files.fstatSync(claimFd));
  try {
    e.files.writeFileSync(claimFd, JSON.stringify({ root, rootIdentity: rootStat }));
    e.files.fsyncSync(claimFd);
    refuseExisting();
    const id = e.nonce(); requireSafe(ID.test(id), 'invalid registration nonce');
    const record = { version: 1, id, uid: e.uid, rootIdentity: rootStat, manifest: m };
    // Recheck paths and manifest after ps calls and claim publication.
    requireSafe(sameInode(rootStat, rootIdentity(e, root)) && sameInode(registryStat, registry(e)) &&
      JSON.stringify(immutable(e, readPrivate(e, path.join(root, 'manifest.json')).value)) === JSON.stringify(m), 'registration changed');
    socket(e, m, false);
    beforeWorkload(e, m);
    const file = path.join(e.directory, `${id}.json`);
    const fd = e.files.openSync(file, e.files.constants.O_WRONLY | e.files.constants.O_CREAT |
      e.files.constants.O_EXCL | e.files.constants.O_NOFOLLOW, 0o600);
    try { e.files.writeFileSync(fd, JSON.stringify(record)); e.files.fsyncSync(fd); }
    finally { e.files.closeSync(fd); }
    return { id, file, root };
  } finally {
    e.files.closeSync(claimFd);
    // Never reclaim another registrar's claim. A crash leaves a visible gate;
    // neither age nor a dead PID is permission to remove it automatically.
    requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
    const owned = readPrivate(e, claim);
    requireSafe(sameInode(owned.stat, claimStat) && owned.value.root === root &&
      sameInode(owned.value.rootIdentity, rootStat), 'registration claim changed');
    e.files.unlinkSync(claim);
  }
}

function storageProof(e, file, registryStat, proof, serverDead) {
  requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
  const loaded = readPrivate(e, file);
  requireSafe(loaded.text === proof.recordText && sameInode(loaded.stat, proof.recordStat), 'registry record changed');
  const m = proof.manifest;
  requireSafe(sameInode(loaded.value.rootIdentity, rootIdentity(e, m.root)), 'root identity changed');
  requireSafe(JSON.stringify(immutable(e, readPrivate(e, path.join(m.root, 'manifest.json')).value)) === JSON.stringify(m), 'immutable manifest fields changed');
  requireSafe(targets(e, m).text === proof.targetText, 'registered targets changed during audit');
  return socket(e, m, serverDead);
}
function readRegistration(e, file, registryStat, initial) {
  requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
  const loaded = readPrivate(e, file), r = loaded.value;
  requireSafe(r?.version === 1 && ID.test(r.id) && path.basename(file) === `${r.id}.json` && r.uid === e.uid, 'invalid registry record');
  if (initial) requireSafe(loaded.text === initial.recordText && sameInode(loaded.stat, initial.recordStat), 'registry record changed');
  const m = immutable(e, r.manifest);
  requireSafe(sameInode(r.rootIdentity, rootIdentity(e, m.root)), 'root identity changed');
  const current = immutable(e, readPrivate(e, path.join(m.root, 'manifest.json')).value);
  requireSafe(JSON.stringify(m) === JSON.stringify(current), 'immutable manifest fields changed');
  const registered = targets(e, m);
  if (initial) requireSafe(registered.text === initial.targetText, 'registered targets changed during audit');
  const all = roles(m).filter(r => r === 'server' || r === 'controller')
    .map(r => ({ pid: m[`${r}Pid`], identity: m[`${r}Identity`] })).concat(registered.list);
  requireSafe(!all.some(t => t.pid === e.selfPid), 'refusing the audit process');
  return { manifest: m, recordText: loaded.text, recordStat: loaded.stat, targetText: registered.text, all };
}
function snapshot(e, file, registryStat, initial) {
  const registration = readRegistration(e, file, registryStat, initial), m = registration.manifest;
  requireEligible(clock(e) >= m.deadline, 'deadline not expired');
  const states = registration.all.map(t => state(e, t));
  socket(e, m, states[0] === 'dead');
  // A different process at an owner or supervisor PID is not proof of death.
  requireEligible(state(e, { pid: m.ownerPid, identity: m.ownerIdentity }) === 'dead', 'owner is alive');
  requireEligible(state(e, { pid: m.supervisorPid, identity: m.supervisorIdentity }) === 'dead', 'supervisor is alive');
  const proof = { ...registration, alive: registration.all.filter((_, i) => states[i] === 'alive') };
  // ps may block. Check storage again after those calls, not only before them.
  return { ...proof, socketPresent: storageProof(e, file, registryStat, proof, states[0] === 'dead') };
}

function escalationFile(file) { return file.replace(/\.json$/, '.escalation.json'); }
function escalationBinding(proof) {
  // Bind TERM authority to this exact registration and target publication.
  // A changed PID list must not inherit a previous target's grace period.
  return createHash('sha256').update(JSON.stringify({ record: proof.recordText,
    inode: proof.recordStat, targets: proof.targetText })).digest('hex');
}
function readEscalation(e, file, proof, initial) {
  const name = escalationFile(file);
  const loaded = missing(() => e.files.lstatSync(name)) ? readPrivate(e, name) : null;
  if (initial !== undefined) requireSafe(loaded?.text === initial?.text &&
    (!loaded || sameInode(loaded.stat, initial.stat)), 'escalation state changed');
  if (!loaded) return null;
  const s = loaded.value;
  requireSafe(s?.version === 1 && s.binding === escalationBinding(proof) &&
    Number.isSafeInteger(s.lastNow) && s.lastNow > 0 && Array.isArray(s.targets) &&
    s.targets.length <= proof.all.length, 'invalid escalation state');
  const seen = new Set();
  for (const t of s.targets) {
    requireSafe(t && proof.all.some(p => p.pid === t.pid && p.identity === t.identity) && !seen.has(t.pid) &&
      Number.isSafeInteger(t.termAt) && t.termAt >= proof.manifest.deadline && t.termAt <= s.lastNow &&
      (t.killAt === null || (Number.isSafeInteger(t.killAt) && t.killAt >= t.termAt + KILL_GRACE_MS &&
        t.killAt <= s.lastNow)), 'invalid escalation target');
    seen.add(t.pid);
  }
  return loaded;
}
function saveEscalation(e, file, registryStat, proof, expected, value) {
  requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
  readEscalation(e, file, proof, expected);
  const name = escalationFile(file), token = e.nonce(); requireSafe(ID.test(token), 'invalid state nonce');
  const temporary = `${name}.${token}.tmp`;
  const fd = e.files.openSync(temporary, e.files.constants.O_WRONLY | e.files.constants.O_CREAT |
    e.files.constants.O_EXCL | e.files.constants.O_NOFOLLOW, 0o600);
  try { e.files.writeFileSync(fd, JSON.stringify(value)); e.files.fsyncSync(fd); }
  finally { e.files.closeSync(fd); }
  // Recheck concurrent writes before publication. Filesystem rename is not a
  // compare-and-swap operation; PID checks also cannot be atomic with kill.
  // An interrupted write leaves private evidence, never KILL authority.
  storageProof(e, file, registryStat, proof, true);
  readEscalation(e, file, proof, expected);
  e.files.renameSync(temporary, name);
  return readEscalation(e, file, proof);
}
function removeEscalation(e, file, proof, expected) {
  const current = readEscalation(e, file, proof, expected);
  if (current) e.files.unlinkSync(escalationFile(file));
}
function authorizeCompletion(e, m) {
  const role = ['owner', 'supervisor'].find(r => m[`${r}Pid`] === e.selfPid);
  requireSafe(role && state(e, { pid: e.selfPid, identity: m[`${role}Identity`] }) === 'alive',
    'only the live owner or supervisor may complete');
}
function stoppedProof(e, root, initial) {
  const loaded = readPrivate(e, path.join(root, 'stopped')), result = loaded.value;
  requireSafe(result?.root === root && result.clean === true && result.cleanupScope === scope.cleanupScope,
    'stopped report does not prove registered cleanup');
  if (initial) requireSafe(loaded.text === initial.text && sameInode(loaded.stat, initial.stat), 'stopped report changed');
  return loaded;
}

/** Call before the driver removes a successfully stopped root. The live owner
 * or supervisor may complete without waiting for the deadline or owner exit.
 * This never signals or removes the root. Failure keeps the registry evidence.
 */
export function complete(root, deps = {}) {
  const e = environment(deps), rootStat = rootIdentity(e, root);
  const m = immutable(e, readPrivate(e, path.join(root, 'manifest.json')).value);
  requireSafe(m.root === root, 'root mismatch');
  authorizeCompletion(e, m);
  const registryStat = registry(e), matches = [];
  for (const name of e.files.readdirSync(e.directory)) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const file = path.join(e.directory, name), loaded = readPrivate(e, file);
    if (loaded.value?.manifest?.root === root) matches.push({ file, loaded });
  }
  // Never guess which of several registrations owns a root, or treat a missing
  // registration as authority. Unrelated registrations remain untouched.
  requireSafe(matches.length === 1, 'expected one matching registry record');
  const { file, loaded } = matches[0];
  const initial = readRegistration(e, file, registryStat);
  requireSafe(initial.recordText === loaded.text && sameInode(initial.recordStat, loaded.stat), 'registry record changed');
  requireSafe(JSON.stringify(initial.manifest) === JSON.stringify(m) &&
    sameInode(rootStat, rootIdentity(e, root)), 'completion root or manifest changed');
  const stopped = stoppedProof(e, root), escalation = readEscalation(e, file, initial);
  // Recheck all process identities and storage twice. Completion never signals,
  // so one fresh process snapshot per pass can replace per-target ps forks.
  // Keep direct caller checks before and after each independently fresh proof.
  for (let n = 0; n < 2; n++) {
    const fresh = readRegistration(e, file, registryStat, initial);
    authorizeCompletion(e, fresh.manifest);
    let proofPs = e;
    if (e.psSnapshot) {
      const processes = processSnapshot(e.psSnapshot());
      proofPs = { ...e, ps: targetPid => processes.get(targetPid) ?? null };
      // Missing or recycled caller rows make the snapshot untrusted for proof.
      authorizeCompletion(proofPs, fresh.manifest);
    }
    for (const target of fresh.all) requireSafe(state(proofPs, target) === 'dead', 'registered process is still alive');
    authorizeCompletion(e, fresh.manifest);
    requireSafe(!storageProof(e, file, registryStat, initial, true), 'completion socket is still present');
    stoppedProof(e, root, stopped);
  }
  requireSafe(sameInode(registryStat, registry(e)), 'registry directory replaced');
  const final = readPrivate(e, file);
  requireSafe(final.text === initial.recordText && sameInode(final.stat, initial.recordStat), 'registry record changed');
  removeEscalation(e, file, initial, escalation);
  // State removal does not grant authority to a replaced registration.
  const last = readPrivate(e, file);
  requireSafe(last.text === initial.recordText && sameInode(last.stat, initial.recordStat), 'registry record changed');
  e.files.unlinkSync(file);
  return { id: loaded.value.id, file, root, status: 'completed', ...scope };
}

/** Dry run never writes. Apply records successful TERM, then permits one KILL
 * after at least ten seconds in a later call, with all safety checks repeated.
 * Failed signals never grant escalation authority. Unknown children are not
 * covered. Roots and sockets are never removed by this module. report.failed
 * counts operational errors, including unsafe metadata, but not eligible skips.
 */
export function audit({ apply = false } = {}, deps = {}) {
  requireSafe(typeof apply === 'boolean', 'apply must be boolean');
  const e = environment(deps), report = { apply, failed: 0, tasks: [], errors: [], ...scope };
  let registryStat, names;
  try {
    if (!missing(() => e.files.lstatSync(e.directory))) return report;
    registryStat = registry(e); names = e.files.readdirSync(e.directory);
  } catch (error) { report.failed++; report.errors.push(error.message); return report; }
  for (const name of names) {
    if (/^[a-f0-9]{32}\.escalation\.json$/.test(name)) continue;
    const task = { id: name, status: 'skipped', failed: false, signals: [], ...scope }; report.tasks.push(task);
    try {
      requireSafe(/^[a-f0-9]{32}\.json$/.test(name), 'invalid registry filename');
      const file = path.join(e.directory, name);
      const initial = snapshot(e, file, registryStat);
      let escalation = readEscalation(e, file, initial);
      const value = escalation ? structuredClone(escalation.value) :
        { version: 1, binding: escalationBinding(initial), lastNow: clock(e), targets: [] };
      requireSafe(clock(e) >= value.lastNow, 'clock moved backward');
      task.root = initial.manifest.root; task.candidates = initial.alive.map(t => t.pid);
      task.status = 'eligible'; task.registeredProcessesGone = initial.alive.length === 0;
      if (!apply) continue;
      for (const target of initial.alive) {
        const fresh = snapshot(e, file, registryStat, initial);
        readEscalation(e, file, initial, escalation);
        const previous = value.targets.find(t => t.pid === target.pid);
        const now = clock(e); requireSafe(now >= value.lastNow, 'clock moved backward');
        if (!fresh.alive.some(t => t.pid === target.pid) || (previous && previous.killAt !== null)) continue;
        if (previous && now - previous.termAt < KILL_GRACE_MS) continue;
        const signal = previous ? 'SIGKILL' : 'SIGTERM';
        // macOS has no pidfd signal API, so checks cannot be atomic with kill.
        // Repeat PID and controller checks, then check storage after ps calls.
        // Never signal process groups or infer other descendants.
        if (state(e, target) === 'dead') continue;
        requireEligible(state(e, { pid: initial.manifest.ownerPid, identity: initial.manifest.ownerIdentity }) === 'dead', 'owner is alive');
        requireEligible(state(e, { pid: initial.manifest.supervisorPid, identity: initial.manifest.supervisorIdentity }) === 'dead', 'supervisor is alive');
        storageProof(e, file, registryStat, initial, !fresh.alive.some(t => t.pid === initial.manifest.serverPid));
        readEscalation(e, file, initial, escalation);
        const signalAt = clock(e);
        requireSafe(signalAt >= initial.manifest.deadline && signalAt >= value.lastNow &&
          (!previous || signalAt >= previous.termAt + KILL_GRACE_MS), 'clock moved backward or grace incomplete');
        try {
          requireSafe(e.signal(target.pid, signal) !== false, 'signal failed');
          task.signals.push(target.pid);
          (task.signalDetails ??= []).push({ pid: target.pid, signal });
        } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
        // Only a successful, still-matching task can publish signal authority.
        snapshot(e, file, registryStat, initial);
        const after = clock(e); requireSafe(after >= signalAt, 'clock moved backward');
        value.lastNow = after;
        if (previous) previous.killAt = after;
        else value.targets.push({ ...target, termAt: after, killAt: null });
        escalation = saveEscalation(e, file, registryStat, initial, escalation, value);
      }
      const final = snapshot(e, file, registryStat, initial);
      readEscalation(e, file, initial, escalation);
      const observed = clock(e); requireSafe(observed >= value.lastNow, 'clock moved backward');
      if (escalation && observed > value.lastNow) {
        value.lastNow = observed;
        escalation = saveEscalation(e, file, registryStat, initial, escalation, value);
      }
      task.registeredProcessesGone = final.alive.length === 0;
      task.remaining = final.alive.map(t => t.pid); task.status = 'retained';
      if (!final.alive.length && !final.socketPresent) {
        // Only registry metadata is removed. Keep all unresolved evidence.
        requireSafe(!storageProof(e, file, registryStat, initial, true), 'socket returned');
        removeEscalation(e, file, initial, escalation);
        const last = readPrivate(e, file);
        requireSafe(last.text === initial.recordText && sameInode(last.stat, initial.recordStat), 'registry record changed');
        e.files.unlinkSync(file); task.status = 'completed';
      }
    } catch (error) {
      task.status = task.signals.length ? 'retained' : 'skipped'; task.reason = error.message;
      task.failed = !(error instanceof Ineligible);
      if (task.failed) report.failed++;
    }
  }
  return report;
}

/** Expected live-controller/deadline skips are not operational failures.
 * Treat missing or invalid failure counts as failed when integrating callers.
 */
export function auditFailed(report) {
  return !Number.isSafeInteger(report?.failed) || report.failed < 0 || report.failed > 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && ['--apply', '--dry-run'].includes(args[0]))) {
    const report = audit({ apply: args[0] === '--apply' });
    console.log(JSON.stringify(report));
    process.exitCode = auditFailed(report) ? 1 : 0;
  } else { console.error('Usage: reap-rex-tests.mjs [--dry-run | --apply]'); process.exitCode = 2; }
}
