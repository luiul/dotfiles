#!/usr/bin/env node
/** Private Rex fixtures. Never use the desktop server or a discovered endpoint.
 * Each suite owns a foreground server on a private socket. The supervisor stays
 * outside that server's process group so owner death and deadlines can clean it.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { register, complete } from '../macos/.local/bin/reap-rex-tests.mjs';
import { startStartupGuard } from './rex-startup-guard.mjs';

const self = fileURLToPath(import.meta.url);
// Bulk snapshots are exit evidence, never signal authority. Signals still use
// a fresh individual UID/start-time check immediately before process.kill.
export function processSnapshot() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,uid=,lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  assert(!result.error && result.status === 0, 'Cannot inspect process snapshot');
  const snapshot = new Map();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    // Darwin uses negative UIDs for some system services. They are rows too,
    // but cannot match any same-user fixture identity used for cleanup.
    const match = /^\s*(\d+)\s+(-?\d+\s+\S.+?)\s*$/.exec(line);
    assert(match, 'Invalid process snapshot row');
    snapshot.set(Number(match[1]), match[2].replace(/\s+/g, ' '));
  }
  return snapshot;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid fixture PID');
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart='], {
    encoding: 'utf8', timeout: 3000, env: { ...cleanEnvironment(), LANG: 'C', LC_ALL: 'C' },
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(`Cannot inspect PID ${pid}: ${r.error?.message || r.stderr}`);
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') || null : null;
}
function cleanEnvironment() {
  // Keep terminal basics, not inherited credentials, loader hooks or agent state.
  const env = { HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', TMPDIR: os.tmpdir() };
  for (const key of Object.keys(env)) if (process.env[key]) env[key] = process.env[key];
  const user = os.userInfo().username;
  return { ...env, USER: user, LOGNAME: user };
}
function privateRoot(root) {
  const canonical = fs.realpathSync(root);
  assert.equal(path.resolve(root), canonical, 'Fixture root must be its real path');
  assert(path.basename(canonical).startsWith('ag-rex-tests-'), 'Not a fixture directory');
  const stat = fs.lstatSync(canonical);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Not a fixture directory');
  assert.equal(stat.uid, process.getuid(), 'Fixture directory owner changed');
  assert.equal(stat.mode & 0o7777, 0o700, 'Fixture directory must have mode 0700');
  return { canonical, stat };
}
function removeOwnedRoot(root, expected) {
  // Move to an unpredictable sibling and recheck identity before recursive
  // removal. If the checked root was replaced, preserve it rather than delete.
  const parked = `${root}-cleanup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.renameSync(root, parked);
  const stat = fs.lstatSync(parked);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    if (!fs.existsSync(root)) fs.renameSync(parked, root);
    throw new Error('Fixture root changed before removal');
  }
  fs.rmSync(parked, { recursive: true });
}
function readPrivateFile(file) {
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink(), 'Fixture metadata must be a regular non-symlink file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    assert.equal(stat.dev, before.dev);
    assert.equal(stat.ino, before.ino, 'Fixture metadata was replaced');
    assert(stat.isFile(), 'Fixture metadata must be a regular file');
    assert.equal(stat.uid, process.getuid(), 'Fixture metadata owner changed');
    assert.equal(stat.mode & 0o077, 0, 'Fixture metadata must be private');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function writePrivateFile(file, text) {
  // Publish complete metadata. Stop and registration readers must not see a
  // manifest or target request halfway through a supervisor update.
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
function readManifest(root, { stopping = false, ownerIdentity, permitExpired = false } = {}) {
  const { canonical } = privateRoot(root);
  const manifest = JSON.parse(readPrivateFile(path.join(canonical, 'manifest.json')));
  assert.equal(manifest.root, canonical);
  assert.equal(manifest.endpoint, `unix://${canonical}/server.sock`);
  assert(Number.isSafeInteger(manifest.ownerPid) && manifest.ownerPid > 1);
  assert.equal(Number(manifest.ownerIdentity?.split(' ')[0]), process.getuid(), 'Fixture owner UID changed');
  if (stopping) {
    assert.equal(manifest.ownerPid, process.pid, 'Only the fixture owner may request stop');
    assert.equal(manifest.ownerIdentity, processIdentity(process.pid), 'Fixture owner identity changed');
  } else {
    if (ownerIdentity) {
      assert.equal(manifest.ownerPid, process.pid);
      assert.equal(manifest.ownerIdentity, ownerIdentity);
    } else assert.equal(manifest.ownerIdentity, processIdentity(manifest.ownerPid), 'Fixture owner changed or exited');
    if (!permitExpired) assert(Date.now() < manifest.deadline, 'Fixture deadline expired');
  }
  return manifest;
}
function dimensions(columns, rows) {
  assert(Number.isSafeInteger(columns) && columns > 0 && columns <= 65535, 'Invalid columns');
  assert(Number.isSafeInteger(rows) && rows > 0 && rows <= 65535, 'Invalid rows');
}
function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}
async function waitForIdentityExit(pid, identity, attempts = 60) {
  const until = Date.now() + attempts * 100;
  while (Date.now() < until) {
    if (processSnapshot().get(pid) !== identity) return true;
    await pause(100);
  }
  return processSnapshot().get(pid) !== identity;
}
function verifySocket(manifest) {
  if (!manifest.socketIdentity) return; // Bootstrap records the socket before any workload.
  const socket = fs.lstatSync(path.join(manifest.root, 'server.sock'));
  assert(socket.isSocket() && !socket.isSymbolicLink(), 'Fixture socket was replaced');
  assert.equal(socket.uid, process.getuid());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal(socket.dev, manifest.socketIdentity.dev);
  assert.equal(socket.ino, manifest.socketIdentity.ino, 'Fixture socket identity changed');
}
function run(manifest, args, json = true) {
  verifySocket(manifest);
  const r = spawnSync(manifest.binary, ['--autostart=false', '--timeout', '4s', '-S', manifest.endpoint, ...args], {
    env: cleanEnvironment(), encoding: 'utf8', timeout: 7000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`Private Rex ${args[0]} failed: ${r.stderr || r.error?.message}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}
const syncWait = new Int32Array(new SharedArrayBuffer(4));
function brokerCall(manifest, method, args) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = path.join(manifest.root, 'requests', `${token}.json`);
  const response = path.join(manifest.root, 'responses', `${token}.json`);
  writePrivateFile(request, JSON.stringify({ method, args }));
  writePrivateFile(path.join(manifest.root, 'request-index'), `${token}.json`);
  const until = Math.min(Date.now() + 7000, manifest.deadline);
  while (!fs.existsSync(response) && Date.now() < until) Atomics.wait(syncWait, 0, 0, 10);
  assert(fs.existsSync(response), `Fixture controller timeout: ${method}`);
  const result = JSON.parse(readPrivateFile(response));
  fs.unlinkSync(response);
  if (result.error) throw new Error(`Private Rex ${method}: ${result.error}`);
  assert(Object.hasOwn(result, 'result') && result.result !== undefined && result.result !== null,
    `Private Rex ${method}: controller returned no result`);
  return result.result;
}
function verifyServer(manifest) {
  assert.equal(manifest.serverIdentity, processIdentity(manifest.serverPid), 'Fixture server process changed');
  verifySocket(manifest);
  const status = manifest.controllerPid ? brokerCall(manifest, 'server.status', {}) : run(manifest, ['whoami', '--json']);
  assert.equal(status.pid, manifest.serverPid);
  assert.equal(status.instance_id, manifest.instanceId);
  if (status.endpoint) assert.equal(status.endpoint, manifest.endpoint);
}

export class RexTestDriver {
  constructor(root) { this.root = root; this.ownerIdentity = processIdentity(process.pid); }
  static async start({ deadlineMs = 8 * 60_000 } = {}) {
    assert(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1000 && deadlineMs <= 30 * 60_000);
    // Darwin Unix socket paths are short. Do not inherit a deep sandbox TMPDIR.
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/ag-rex-tests-'));
    fs.chmodSync(root, 0o700);
    const driver = new RexTestDriver(root);
    let supervisor, launchError;
    try {
      const binary = execFileSync('/usr/bin/which', ['rex'], { encoding: 'utf8', env: cleanEnvironment(), timeout: 3000 }).trim();
      const manifest = { root, binary, endpoint: `unix://${root}/server.sock`, ownerPid: process.pid,
        ownerIdentity: processIdentity(process.pid), deadline: Date.now() + deadlineMs };
      writePrivateFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
      supervisor = spawn(process.execPath, [self, 'supervise', root], { detached: true, stdio: 'ignore', env: cleanEnvironment() });
      supervisor.on('error', error => { launchError = error; });
      await spawned(supervisor);
      driver.supervisorPid = supervisor.pid;
      driver.supervisorIdentity = processIdentity(supervisor.pid);
      supervisor.unref();
      assert(driver.supervisorIdentity, 'Cannot record supervisor identity');
      const until = Date.now() + 20_000;
      while (Date.now() < until && !fs.existsSync(path.join(root, 'ready'))) {
        if (launchError) throw launchError;
        if (fs.existsSync(path.join(root, 'failed'))) throw new Error(readPrivateFile(path.join(root, 'failed')));
        assert(supervisor.exitCode === null && supervisor.signalCode === null, 'Private Rex supervisor exited before readiness');
        await pause(100);
      }
      assert(fs.existsSync(path.join(root, 'ready')), 'Private Rex supervisor did not become ready');
      driver.manifest();
      return driver;
    } catch (error) {
      // Readiness failure is not permission to abandon a detached supervisor.
      // Request shutdown and retain evidence whenever its cleanup is unresolved.
      try {
        if (supervisor?.pid) await driver.stop();
        else {
          privateRoot(root);
          writePrivateFile(path.join(root, 'stop'), '');
          assert(!supervisor || launchError, 'Supervisor launch is unresolved');
          fs.rmSync(root, { recursive: true });
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Fixture startup failed; cleanup unresolved at ${root}`);
      }
      error.fixtureRoot = root;
      throw error;
    }
  }
  manifest() {
    const m = readManifest(this.root, { ownerIdentity: this.ownerIdentity });
    verifySocket(m);
    // The broker verifies the server instance on its existing connection before
    // every request. No fresh connection can redirect an operation after this.
    return m;
  }
  api(method, args) {
    return brokerCall(this.manifest(), method, args);
  }
  create({ name, command, cwd = process.cwd(), env = {}, columns = 120, rows = 40 }) {
    assert(Array.isArray(command) && command.length > 0, 'Command must be an argv array');
    assert(fs.statSync(cwd).isDirectory());
    dimensions(columns, rows);
    // Mac Rex uses login as its outer child. Record the actual exec target PID,
    // not the login PID reported by process.child.
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const m = this.manifest();
    const pidFile = path.join(m.root, `${token}.pid`);
    const identityFile = path.join(m.root, `${token}.identity`);
    const registeredFile = path.join(m.root, `${token}.registered`);
    // Defaults use a private home too. An explicit real HOME is reserved for
    // a harness that intentionally verifies trusted GUI credential recovery.
    const fixtureHome = path.join(m.root, `${token}.home`);
    fs.mkdirSync(fixtureHome, { mode: 0o700 });
    const targetEnv = { ...cleanEnvironment(), HOME: fixtureHome,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env };
    for (const [key, value] of Object.entries(targetEnv)) {
      assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key), 'Invalid fixture environment key');
      assert(typeof value === 'string' && !value.includes('\0'), 'Invalid fixture environment value');
    }
    assert(command.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'Invalid fixture argv');
    // Publish UID and start time before exec, then wait for supervisor tracking.
    // A just-launched command cannot run before cleanup knows its identity.
    writePrivateFile(path.join(m.root, `${token}.target.json`), JSON.stringify({ pidFile, identityFile, registeredFile }));
    const cancelledFile = path.join(m.root, `${token}.cancelled`);
    const stopFile = path.join(m.root, 'stop');
    const launch = `umask 077; LC_ALL=C /bin/ps -p "$$" -o uid=,lstart= > ${quote(identityFile)} && echo $$ > ${quote(`${pidFile}.tmp`)} && /bin/mv ${quote(`${pidFile}.tmp`)} ${quote(pidFile)} || exit 125; n=0; while [ ! -f ${quote(registeredFile)} ]; do [ ! -e ${quote(stopFile)} ] && [ "$n" -lt 100 ] || exit 125; /bin/sleep 0.1; n=$((n + 1)); done; [ ! -e ${quote(stopFile)} ] || exit 125; exec /usr/bin/env -i ${Object.entries(targetEnv).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${command.map(quote).join(' ')}`;
    const response = this.api('session.create', { label: name ?? `ag-test-${token}`, initial_windows: [{
      layout: { block: { flavor: 'com.superlogical.terminal.shell', options: {
        shell: 'none', login: false, command: ['/bin/sh', '-c', launch], cwd, size: { columns, rows }, exit: { on_completion: false },
      } } },
    }] });
    const host = { sessionId: response.session_id, windowId: response.initial_windows[0].window_id,
      blockId: response.initial_windows[0].block_ids[0], pidFile, cancelledFile, columns, rows };
    return host;
  }
  registerChild(pid) {
    assert(Number.isSafeInteger(pid) && pid > 1);
    const m = this.manifest();
    assert(![process.pid, m.serverPid, m.supervisorPid].includes(pid));
    const identity = processIdentity(pid);
    assert(identity && Number(identity.split(' ')[0]) === process.getuid());
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pidFile = path.join(m.root, `${token}.pid`);
    const identityFile = path.join(m.root, `${token}.identity`);
    const registeredFile = path.join(m.root, `${token}.registered`);
    writePrivateFile(identityFile, identity);
    writePrivateFile(pidFile, String(pid));
    writePrivateFile(path.join(m.root, `${token}.target.json`), JSON.stringify({ pidFile, identityFile, registeredFile }));
    return registeredFile;
  }
  method(host, method, args = {}) {
    return this.api('block.method', { session_id: host.sessionId, block_id: host.blockId, method, args });
  }
  capture(host, { format = 'text', trim = false, history = false } = {}) {
    // Rex plain text omits trailing blank rows, even with trim disabled. VT
    // retains those rows. Its default linear redraw has no extra cursor/modes.
    // Slice that row-preserving frame first, then remove style for plain text.
    const currentText = !history && format === 'text';
    const result = this.method(host, 'format', { format: currentText ? 'vt' : format, trim: currentText ? false : trim, max_bytes: 48 * 1024 });
    let text = result.content;
    let offset = Buffer.byteLength(text);
    while (result.id && offset < result.total) {
      const chunk = this.method(host, 'blob_read', { id: result.id, offset, max_bytes: 48 * 1024 });
      text += chunk.data; offset += Buffer.byteLength(chunk.data);
      if (chunk.eof) break;
    }
    // VT is a redraw stream, not the original writes. Style tests must parse it
    // as a terminal frame rather than delete arbitrary escape sequences.
    if (history || format !== 'text') return text;
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    // format(vt) emits a separator after each row, including an extra empty
    // terminal line at the end. Retain it: it accounts for the blank last row.
    const viewport = lines.slice(-this.method(host, 'size').rows).map(stripVTControlCharacters);
    return (trim ? viewport.map(line => line.replace(/[ \t]+$/g, '')) : viewport).join('\n');
  }
  text(host, data) { return this.method(host, 'write', { data }); }
  key(host, chord) {
    const parts = chord.toLowerCase().split('+');
    const key = parts.pop();
    const modifiers = new Set(parts.map(m => m === 'cmd' ? 'super' : m));
    assert([...modifiers].every(m => ['shift', 'ctrl', 'alt', 'super'].includes(m)), 'Unsupported key modifier');
    const named = { enter: 'enter', escape: 'escape', tab: 'tab', backspace: 'backspace', delete: 'delete',
      up: 'arrow_up', down: 'arrow_down', left: 'arrow_left', right: 'arrow_right',
      home: 'home', end: 'end', pageup: 'page_up', pagedown: 'page_down', space: 'space' };
    const physical = named[key] ?? (/^[a-z]$/.test(key) ? `key_${key}` : /^[0-9]$/.test(key) ? `digit_${key}` : null);
    assert(physical, `Unsupported test key: ${chord}`);
    let text = key.length === 1 ? (modifiers.has('shift') ? key.toUpperCase() : key) : ({ enter: '\r', tab: '\t', backspace: '\x7f', space: ' ' }[key] ?? '');
    if (modifiers.has('ctrl') || modifiers.has('super')) text = '';
    const payload = { key: physical, mods: ['shift', 'ctrl', 'alt', 'super'].filter(m => modifiers.has(m)).join('+'),
      consumed_mods: modifiers.has('shift') && key.length === 1 ? 'shift' : '', text,
      unshifted_codepoint: key.length === 1 ? key.codePointAt(0) : ({ enter: 13, tab: 9, backspace: 127, escape: 27, space: 32 }[key] ?? 0), composing: false, action: 'press' };
    const args = { session_id: host.sessionId, block_id: host.blockId, event: { type: 'key', payload } };
    this.api('block.event', args);
    payload.action = 'release';
    return this.api('block.event', args);
  }
  resize(host, columns, rows) {
    dimensions(columns, rows);
    const m = this.manifest();
    const size = brokerCall(m, '__resize', { session_id: host.sessionId, block_id: host.blockId, columns, rows });
    assert.equal(size.columns, columns); assert.equal(size.rows, rows);
    host.columns = columns; host.rows = rows;
    return size;
  }
  process(host) { return this.method(host, 'process'); }
  pid(host) { return fs.existsSync(host.pidFile) ? Number(readPrivateFile(host.pidFile).trim()) : null; }
  close(host) {
    // Close through Rex first so it can release the PTY and its normal child.
    // The supervisor still owns cleanup of registered exec targets at stop.
    const result = this.api('session.destroy', { session_id: host.sessionId });
    // After Rex confirms closure, a never-started wrapper cannot publish a
    // target. Mark that exact request canceled instead of inventing a PID.
    if (!fs.existsSync(host.pidFile) && host.cancelledFile) writePrivateFile(host.cancelledFile, '');
    return result;
  }
  async stop() {
    if (!fs.existsSync(this.root)) return;
    const initial = privateRoot(this.root);
    readManifest(this.root, { stopping: true });
    // Public constructor input is never authority to write or remove a root.
    writePrivateFile(path.join(initial.canonical, 'stop'), '');
    for (let n = 0; n < 300 && !fs.existsSync(path.join(this.root, 'stopped')); n++) await pause(100);
    assert(fs.existsSync(path.join(this.root, 'stopped')), `Fixture supervisor failed to stop; retained ${this.root}`);
    const result = JSON.parse(readPrivateFile(path.join(this.root, 'stopped')));
    assert.equal(result.root, initial.canonical);
    assert(result.clean, JSON.stringify(result));
    const m = readManifest(this.root, { stopping: true });
    const supervisorPid = this.supervisorPid ?? m.supervisorPid;
    const supervisorIdentity = this.supervisorIdentity ?? m.supervisorIdentity;
    assert(supervisorPid && supervisorIdentity, 'Supervisor identity was not recorded');
    assert(await waitForIdentityExit(supervisorPid, supervisorIdentity), 'Fixture supervisor is still alive');
    const final = privateRoot(this.root);
    assert.equal(final.stat.dev, initial.stat.dev);
    assert.equal(final.stat.ino, initial.stat.ino, 'Fixture directory was replaced');
    if (m.startupGuardPid) {
      const handoffFile = path.join(final.canonical, 'startup-handoff.json');
      const stoppedFile = path.join(final.canonical, 'startup-stopped.json');
      if (fs.existsSync(stoppedFile)) {
        const proof = JSON.parse(readPrivateFile(stoppedFile));
        assert.equal(proof.root, final.canonical);
        assert.equal(proof.guardPid, m.startupGuardPid);
        assert(proof.clean && proof.socketAbsent, 'Unresolved startup guard report');
      } else {
        const proof = JSON.parse(readPrivateFile(handoffFile));
        assert.equal(proof.root, final.canonical);
        assert.equal(proof.guardPid, m.startupGuardPid);
        assert.equal(proof.registration, m.registration?.id);
      }
      assert(!processSnapshot().has(m.startupGuardPid), 'Startup guard is still alive');
    }
    if (fs.existsSync(path.join(final.canonical, 'deregistered'))) {
      const proof = JSON.parse(readPrivateFile(path.join(final.canonical, 'deregistered')));
      assert.equal(proof.root, final.canonical);
      assert.equal(proof.status, 'completed');
    } else if (m.registration) complete(final.canonical);
    // Quarantine and recheck before removal, not a checked pathname alone.
    removeOwnedRoot(final.canonical, final.stat);
    return result;
  }
}

async function supervise(root) {
  process.umask(0o077);
  // Signals request normal teardown. The startup guard covers SIGKILL before
  // registry handoff. After handoff, the explicit registry is the backstop.
  const requestStop = () => {
    try { writePrivateFile(path.join(root, 'stop'), ''); } catch { /* Keep teardown bounded. */ }
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  // Refuse untrusted constructor paths before any failure report can write.
  let manifest = readManifest(root, { permitExpired: true });
  // This directory has exactly one supervisor. An atomic claim prevents a
  // duplicate launch from overwriting ownership before any child is spawned.
  const claim = path.join(root, 'supervisor-claim');
  const claimFd = fs.openSync(claim, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  fs.writeFileSync(claimFd, String(process.pid)); fs.closeSync(claimFd);
  assert(!manifest.supervisorPid && !manifest.registration, 'Fixture already has a supervisor');
  let server, controller, guard, guarded = false;
  const targets = new Map(), pending = new Set(), errors = [];
  const saveManifest = () => writePrivateFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  function registerTargets({ allowExecution = false } = {}) {
    for (const file of fs.readdirSync(root)) {
      const match = /^([0-9]+-[a-f0-9]+)\.target\.json$/.exec(file);
      if (!match || targets.has(file)) continue;
      const request = JSON.parse(readPrivateFile(path.join(root, file)));
      assert.equal(request.pidFile, path.join(root, `${match[1]}.pid`));
      assert.equal(request.identityFile, path.join(root, `${match[1]}.identity`));
      assert.equal(request.registeredFile, path.join(root, `${match[1]}.registered`));
      pending.add(file);
      if (!fs.existsSync(request.pidFile)) {
        const canceled = path.join(root, `${match[1]}.cancelled`);
        if (fs.existsSync(canceled)) { readPrivateFile(canceled); pending.delete(file); }
        continue;
      }
      const pidText = readPrivateFile(request.pidFile).trim();
      if (!pidText) continue; // The shell may still be publishing its startup PID.
      assert(/^[0-9]+$/.test(pidText), 'Invalid target PID file');
      const pid = Number(pidText);
      assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid target PID');
      assert(![process.pid, manifest?.ownerPid, server?.pid].includes(pid), 'Target PID names a fixture controller');
      const identity = readPrivateFile(request.identityFile).trim().replace(/\s+/g, ' ');
      assert(/^\d+ \S.+$/.test(identity), 'Target startup identity is missing');
      assert.equal(Number(identity.split(' ')[0]), process.getuid(), 'Target owner changed');
      targets.set(file, { pid, identity });
      pending.delete(file);
      // Persist before readiness or shutdown. PID reuse must never retarget a kill.
      writePrivateFile(path.join(root, 'targets.json'), JSON.stringify([...targets.values()]));
      if (allowExecution && !fs.existsSync(path.join(root, 'stop')) && Date.now() < manifest.deadline &&
        manifest.ownerIdentity === processIdentity(manifest.ownerPid) && processIdentity(pid) === identity) {
        // Acknowledgment comes after durable registration. Cleanup never grants
        // execution, even if a wrapper publishes its PID during server shutdown.
        writePrivateFile(request.registeredFile, '');
      }
    }
  }
  function signalTarget(target, signal) {
    if (processIdentity(target.pid) !== target.identity) return;
    assert.equal(Number(target.identity.split(' ')[0]), process.getuid());
    try { process.kill(target.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const survivingTargets = () => {
    const snapshot = processSnapshot();
    return [...targets.values()].filter(target => snapshot.get(target.pid) === target.identity);
  };
  const waitForTargets = async milliseconds => {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) {
      if (!survivingTargets().length) return;
      await pause(100);
    }
  };
  try {
    manifest.supervisorPid = process.pid;
    manifest.supervisorIdentity = processIdentity(process.pid);
    assert(manifest.supervisorIdentity, 'Cannot record supervisor identity');
    saveManifest();
    assert(Date.now() < manifest.deadline, 'Fixture deadline expired before server launch');
    // The guard owns the only liveness pipe before it can create either child.
    // A supervisor killed before publication cannot orphan an untracked child.
    guard = await startStartupGuard(root, cleanEnvironment());
    guarded = true;
    manifest.startupGuardPid = guard.pid;
    saveManifest();
    writePrivateFile(path.join(root, 'init.lua'), '');
    server = await guard.spawn('server');
    manifest.serverPid = server.pid;
    for (let n = 0; n < 20 && !manifest.serverIdentity; n++) {
      manifest.serverIdentity = processIdentity(server.pid);
      if (!manifest.serverIdentity) await pause(100);
    }
    // Save the child identity before any readiness call can fail or time out.
    saveManifest();
    assert(manifest.serverIdentity, 'Cannot record server identity');
    for (let n = 0; n < 150 && !fs.existsSync(path.join(root, 'server.sock')); n++) {
      assert(server.exitCode === null && server.signalCode === null, 'Private Rex server exited before readiness');
      assert(!fs.existsSync(path.join(root, 'stop')), 'Fixture stop requested during startup');
      assert(Date.now() < manifest.deadline, 'Fixture deadline expired during startup');
      assert.equal(manifest.ownerIdentity, processIdentity(manifest.ownerPid), 'Fixture owner exited during startup');
      await pause(100);
    }
    const socket = fs.lstatSync(path.join(root, 'server.sock'));
    assert(socket.isSocket() && socket.uid === process.getuid() && (socket.mode & 0o777) === 0o600);
    manifest.socketIdentity = { dev: socket.dev, ino: socket.ino };
    const status = run(manifest, ['whoami', '--json']);
    manifest.instanceId = status.instance_id;
    assert.equal(status.pid, server.pid); assert.equal(status.endpoint, manifest.endpoint);
    assert.equal(processIdentity(server.pid), manifest.serverIdentity, 'Server identity changed before readiness');
    saveManifest();
    fs.mkdirSync(path.join(root, 'requests'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'responses'), { mode: 0o700 });
    const broker = path.join(root, 'controller.lua');
    writePrivateFile(broker, `local root=${JSON.stringify(root)}
local instance=${JSON.stringify(manifest.instanceId)}
-- rex.call can return nil,error instead of throwing. Preserve that error, and
-- never encode a missing result as a successful empty broker response.
local function checkedCall(method,args)
  local value,err=rex.call(method,args)
  assert(value~=nil,tostring(err or (method..": missing result")))
  return value
end
local ready=assert(io.open(root.."/controller-ready","w")); ready:write("ready"); ready:close()
while true do
  if io.open(root.."/stop","r") then break end
  local p=assert(io.open(root.."/request-index","r"))
  local names=p:read("*a"); p:close()
  for name in string.gmatch(names,"[^\\n]+") do
    local file=root.."/requests/"..name
    local f=io.open(file,"r")
    if f then
      local raw=f:read("*a"); f:close(); os.remove(file)
      local ok,value=pcall(function()
        local req=rex.json.decode(raw)
        local s=checkedCall("server.status")
        assert(s.instance_id==instance,"Fixture server changed")
        local a=req.args or {}
        if a.session_id then checkedCall("session.attach",{session_id=a.session_id}) end
        if req.method=="__resize" then
          checkedCall("session.own_block",{session_id=a.session_id,block_ids={a.block_id},mode="take"})
          checkedCall("block.method",{session_id=a.session_id,block_id=a.block_id,method="resize",args={columns=a.columns,rows=a.rows}})
          return checkedCall("block.method",{session_id=a.session_id,block_id=a.block_id,method="size"})
        end
        return checkedCall(req.method,a)
      end)
      local out=root.."/responses/"..name
      local t=assert(io.open(out..".tmp","w"))
      t:write(rex.json.encode(ok and {result=value} or {error=tostring(value)})); t:close(); os.rename(out..".tmp",out)
    end
  end
  rex.sleep(0.01)
end
`);
    writePrivateFile(path.join(root, 'request-index'), '');
    controller = await guard.spawn('controller');
    manifest.controllerPid = controller.pid; manifest.controllerIdentity = processIdentity(controller.pid);
    saveManifest();
    for (let n = 0; n < 80 && !fs.existsSync(path.join(root, 'controller-ready')); n++) {
      assert(controller.exitCode === null && controller.signalCode === null, 'Fixture controller exited before readiness');
      await pause(100);
    }
    assert(fs.existsSync(path.join(root, 'controller-ready')), 'Fixture controller not ready');
    // A private test manifest can inject death at the last unregistered stage.
    // No public driver API or inherited environment enables this injection.
    if (manifest.bootstrapKillStage === 'pre-registration') {
      writePrivateFile(path.join(root, 'bootstrap-stage.json'), JSON.stringify({ stage: 'pre-registration', supervisorPid: process.pid }));
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    }
    // Keep ownership through registration publication and the verified handoff.
    // Never mutate server/controller identities after the registry pins them.
    manifest.registration = register(root);
    saveManifest();
    await guard.handoff();
    guarded = false;
    writePrivateFile(path.join(root, 'ready'), '');
    while (Date.now() < manifest.deadline && manifest.ownerIdentity === processIdentity(manifest.ownerPid) &&
      !fs.existsSync(path.join(root, 'stop')) && server.exitCode === null && server.signalCode === null) {
      if (processIdentity(server.pid) !== manifest.serverIdentity) break;
      registerTargets({ allowExecution: true });
      assert.equal(processIdentity(controller.pid), manifest.controllerIdentity, 'Fixture controller exited');
      await pause(250);
    }
  } catch (error) {
    if (error.fixtureCleanupUnresolved) errors.push(String(error));
    writePrivateFile(path.join(root, 'failed'), String(error));
  } finally {
    // Pre-handoff failure uses direct guard handles, including children whose
    // identities never reached this supervisor. Preserve unresolved reports.
    if (guarded) {
      try {
        await guard.stop();
        const report = JSON.parse(readPrivateFile(path.join(root, 'startup-stopped.json')));
        if (!report.clean) errors.push(`Startup cleanup unresolved: ${JSON.stringify(report)}`);
      } catch (error) { errors.push(String(error)); }
    }
    if (!guarded && controller?.pid && processSnapshot().get(controller.pid) === manifest.controllerIdentity) {
      signalTarget({ pid: controller.pid, identity: manifest.controllerIdentity }, 'SIGTERM');
      await waitForIdentityExit(controller.pid, manifest.controllerIdentity, 20);
      signalTarget({ pid: controller.pid, identity: manifest.controllerIdentity }, 'SIGKILL');
    }
    let serverGone = !server?.pid;
    try { registerTargets(); } catch (error) { errors.push(String(error)); }
    try {
      if (server?.pid && !guarded) {
        const identity = manifest?.serverIdentity;
        const current = processIdentity(server.pid);
        if (!identity) {
          // Without a recorded identity, do not guess which process to kill.
          serverGone = !current;
          if (current) errors.push('Server identity was not recorded; cleanup unresolved');
        } else {
          if (current === identity) {
            // Let Rex close PTYs first. Fallback signals target only our server.
            try { run(manifest, ['api', 'call', 'server.stop', '{}']); } catch { signalTarget({ pid: server.pid, identity }, 'SIGTERM'); }
            serverGone = await waitForIdentityExit(server.pid, identity, 40);
            if (!serverGone) {
              signalTarget({ pid: server.pid, identity }, 'SIGKILL');
              serverGone = await waitForIdentityExit(server.pid, identity, 20);
            }
          } else serverGone = true;
        }
      }
      if (guarded && server?.pid) serverGone = processIdentity(server.pid) !== manifest.serverIdentity;
      // A target can publish its startup file while Rex is closing its PTY.
      registerTargets();
      // Retired targets need no repeated ps spawn. Poll one fresh snapshot per
      // phase, then individually recheck only the targets about to be signaled.
      for (const target of survivingTargets()) signalTarget(target, 'SIGTERM');
      await waitForTargets(3000);
      for (const target of survivingTargets()) signalTarget(target, 'SIGKILL');
      await waitForTargets(2000);
      registerTargets();
    } catch (error) { errors.push(String(error)); }
    let survivors = [];
    try { survivors = survivingTargets(); } catch (error) { errors.push(String(error)); }
    // This proves only the server and registered exec targets are gone.
    // Unknown self-detaching descendants remain an unresolved coverage gate.
    const clean = serverGone && (!controller?.pid || !processIdentity(controller.pid)) && !fs.existsSync(path.join(root, 'server.sock')) &&
      survivors.length === 0 && pending.size === 0 && errors.length === 0;
    writePrivateFile(path.join(root, 'stopped'), JSON.stringify({ root, clean, serverPid: server?.pid,
      survivors, pending: [...pending], errors, cleanupScope: 'server-and-registered-targets-only',
      unknownSelfDetachingChildren: 'unresolved' }));
    if (clean && manifest.registration) {
      try { writePrivateFile(path.join(root, 'deregistered'), JSON.stringify(complete(root))); }
      catch (error) { writePrivateFile(path.join(root, 'failed'), `Registry completion unresolved: ${error}`); }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === 'supervise') await supervise(process.argv[3]);
  else throw new Error('Import RexTestDriver from a test harness');
}
