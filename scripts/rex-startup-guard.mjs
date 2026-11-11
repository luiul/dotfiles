#!/usr/bin/env node
/** Bootstrap owns ChildProcess handles, not discovered PIDs or process groups.
 * Only this guard holds the supervisor IPC pipe. Rex children get no pipe copy.
 * Ownership is released only after the complete registry is checked on disk.
 * Simultaneous SIGKILL of guard and supervisor is not covered. No signal or
 * cleanup authority is inferred for unknown self-detaching descendants.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = child => child.pid && child.exitCode === null && child.signalCode === null;

export async function cleanupOwned(children, { termMs = 2000, killMs = 2000, sleep = pause, now = Date.now } = {}) {
  const signals = [], errors = [];
  const signal = sig => {
    for (const [role, child] of children) {
      if (!alive(child)) continue;
      try {
        // Direct, unreaped children remain ours even before identity publication.
        // Never signal a group or a PID learned from ps or a manifest.
        if (child.kill(sig)) signals.push({ role, pid: child.pid, signal: sig });
      } catch (error) { errors.push(String(error)); }
    }
  };
  const wait = async ms => {
    const until = now() + ms;
    while ([...children.values()].some(alive) && now() < until) await sleep(25);
  };
  signal('SIGTERM'); await wait(termMs);
  signal('SIGKILL'); await wait(killMs);
  return { signals, errors, survivors: [...children].filter(([, child]) => alive(child)).map(([role, child]) => ({ role, pid: child.pid })) };
}

export function verifyStartupHandoff(manifest, record, children, rootStat, uid) {
  assert.equal(record.version, 1);
  assert.equal(record.uid, uid);
  assert.equal(record.rootIdentity.dev, rootStat.dev);
  assert.equal(record.rootIdentity.ino, rootStat.ino);
  const pinned = record.manifest;
  // Every registry field stays immutable. In particular, keep both child roles.
  for (const [key, value] of Object.entries(pinned)) assert.deepEqual(manifest[key], value, `Registration changed: ${key}`);
  for (const role of ['server', 'controller']) {
    const child = children.get(role);
    assert(child && alive(child), `Missing live owned ${role}`);
    assert.equal(pinned[`${role}Pid`], child.pid);
    assert.equal(typeof pinned[`${role}Identity`], 'string');
    assert(pinned[`${role}Identity`].startsWith(`${uid} `));
  }
}

export async function startStartupGuard(root, env) {
  const guard = spawn(process.execPath, [self, root], {
    detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const children = new Map(), pending = new Map();
  let sequence = 0, closed = false;
  const fail = error => {
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  guard.on('error', fail);
  guard.on('exit', () => fail(new Error('Startup guard exited')));
  guard.on('disconnect', () => fail(new Error('Startup guard disconnected')));
  guard.on('message', message => {
    if (message.type === 'exit') {
      const child = children.get(message.role);
      if (child) { child.exitCode = message.code; child.signalCode = message.signal; }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  const request = (type, args = {}) => new Promise((resolve, reject) => {
    if (closed || !guard.connected) return reject(new Error('Startup guard is unavailable'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Startup guard timeout: ${type}`)); }, 8000);
    pending.set(id, { resolve, reject, timer });
    guard.send({ type, id, ...args }, error => { if (error) fail(error); });
  });
  // Exit is bounded even if a child fails to die. Its retained report must not
  // be turned into permission to remove the root or to signal a discovered PID.
  const waitExit = () => new Promise((resolve, reject) => {
    if (guard.exitCode !== null || guard.signalCode !== null) return resolve();
    const timer = setTimeout(() => { guard.unref(); if (guard.connected) guard.disconnect(); reject(new Error('Startup guard exit unresolved')); }, 6000);
    guard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  // An init exchange proves the EOF handler and deadline exist before any spawn.
  let ready;
  try { ready = await request('init'); }
  catch (error) {
    // Init failure still owns the guard. Close its pipe and prove exit before
    // returning, so the caller cannot remove a root with a live guard writer.
    if (guard.connected) guard.disconnect();
    try { await waitExit(); }
    catch (cleanupError) {
      const unresolved = new AggregateError([error, cleanupError], `Startup guard unresolved at ${root}`);
      unresolved.fixtureCleanupUnresolved = true;
      throw unresolved;
    }
    throw error;
  }
  return { pid: guard.pid, deadline: ready.deadline,
    async spawn(role) {
      const result = await request('spawn', { role });
      const child = { pid: result.pid, exitCode: null, signalCode: null };
      children.set(role, child);
      return child;
    },
    async handoff() {
      await request('handoff');
      // Wait for exit so natural root cleanup cannot race a guard writer.
      await waitExit();
    },
    async stop() {
      if (guard.exitCode !== null || guard.signalCode !== null) return;
      if (guard.connected && !closed) { try { await request('stop'); } catch {} }
      if (guard.connected) guard.disconnect();
      await waitExit();
    },
  };
}

async function serve(root) {
  process.umask(0o077);
  assert(process.send, 'Guard requires a supervisor IPC pipe');
  assert(/^\/private\/tmp\/ag-rex-tests-[A-Za-z0-9_-]+$/.test(root));
  const rootStat = fs.lstatSync(root), uid = process.getuid();
  const checkRoot = () => {
    const stat = fs.lstatSync(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o7777) === 0o700);
    assert.equal(fs.realpathSync(root), root);
    assert.equal(stat.dev, rootStat.dev); assert.equal(stat.ino, rootStat.ino);
  };
  const read = file => {
    checkRoot();
    const before = fs.lstatSync(file);
    assert(before.isFile() && !before.isSymbolicLink() && before.uid === uid && (before.mode & 0o7777) === 0o600 && before.nlink === 1);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      assert.equal(stat.dev, before.dev); assert.equal(stat.ino, before.ino);
      assert(stat.isFile() && stat.size <= 1024 * 1024);
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  };
  const write = (name, value) => {
    checkRoot();
    const file = path.join(root, name), temporary = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
    checkRoot(); fs.renameSync(temporary, file);
  };
  const initial = read(path.join(root, 'manifest.json'));
  assert.equal(initial.root, root); assert.equal(initial.endpoint, `unix://${root}/server.sock`);
  assert.equal(initial.supervisorPid, process.ppid);
  assert(Number.isSafeInteger(initial.deadline) && initial.deadline > 0);
  const deadline = Math.min(initial.deadline, Date.now() + 20_000);
  const children = new Map(), records = [];
  let ending = false, handedOff = false, cleanup;
  const reply = (id, result, error) => {
    if (process.connected) process.send({ id, result, error }, () => {});
  };
  const stop = reason => {
    if (handedOff) return;
    if (cleanup) return cleanup;
    ending = true; clearTimeout(timer);
    cleanup = (async () => {
      const result = await cleanupOwned(children);
      let socketAbsent = false;
      try { checkRoot(); socketAbsent = !fs.existsSync(path.join(root, 'server.sock')); }
      catch (error) { result.errors.push(String(error)); }
      const report = { root, clean: !result.survivors.length && !result.errors.length && socketAbsent,
        reason, guardPid: process.pid, owned: records, socketAbsent, ...result,
        cleanupScope: 'server-and-registered-targets-only', unknownSelfDetachingChildren: 'unresolved' };
      try {
        write('startup-stopped.json', report);
        // The supervisor can be alive on a normal failure. It writes its own
        // final report after this guard exits. EOF has no surviving reporter.
        if (reason === 'supervisor-eof' || reason === 'startup-deadline') write('stopped', report);
      } catch { process.exitCode = 1; }
      for (const child of children.values()) child.unref();
      if (process.connected) process.disconnect();
    })();
    return cleanup;
  };
  const timer = setTimeout(() => void stop('startup-deadline'), Math.max(1, deadline - Date.now()));
  const inject = stage => {
    if (initial.bootstrapKillStage !== stage) return false;
    write('bootstrap-stage.json', { stage, supervisorPid: initial.supervisorPid, owned: records });
    // Test-only private manifest input. The connected supervisor is our parent,
    // not an observed process group or a Rex endpoint discovered elsewhere.
    assert.equal(process.ppid, initial.supervisorPid);
    process.kill(initial.supervisorPid, 'SIGKILL');
    return true;
  };
  process.once('disconnect', () => void stop('supervisor-eof'));
  process.once('SIGTERM', () => void stop('guard-signal'));
  process.once('SIGINT', () => void stop('guard-signal'));
  process.on('message', async message => {
    if (ending) return reply(message.id, null, 'Startup guard is stopping');
    try {
      assert(Date.now() < deadline, 'Startup deadline expired');
      if (message.type === 'init') return reply(message.id, { deadline });
      if (message.type === 'stop') { await stop('supervisor-stop'); return; }
      if (message.type === 'spawn') {
        assert(['server', 'controller'].includes(message.role) && !children.has(message.role));
        checkRoot();
        const server = message.role === 'server';
        if (server && inject('before-socket')) return;
        const args = server ? ['--autostart=false', 'server', 'run', '--listen', initial.endpoint,
          '--socket-mode', '0600', '--state-dir', path.join(root, 'state'), '--config', path.join(root, 'init.lua'), '--restore=false'] :
          ['--autostart=false', '--timeout', '4s', '-S', initial.endpoint, 'do', path.join(root, 'controller.lua'), '--all'];
        let log;
        if (server) log = fs.openSync(path.join(root, 'server.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        let child;
        try {
          // Explicit stdio and env do not inherit the guard's IPC descriptor.
          child = spawn(initial.binary, args, { env: { ...process.env, NODE_CHANNEL_FD: undefined, NODE_CHANNEL_SERIALIZATION_MODE: undefined },
            detached: true, stdio: server ? ['ignore', log, log] : 'ignore' });
          children.set(message.role, child); // Ownership precedes every await.
          records.push({ role: message.role, pid: child.pid });
          child.on('error', () => {});
          child.on('exit', (code, signal) => {
            if (process.connected) process.send({ type: 'exit', role: message.role, code, signal }, () => {});
          });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        } finally { if (log !== undefined) fs.closeSync(log); }
        if (inject(server ? 'after-server' : 'after-controller')) return;
        return reply(message.id, { pid: child.pid });
      }
      assert.equal(message.type, 'handoff');
      const manifest = read(path.join(root, 'manifest.json'));
      const registration = manifest.registration;
      assert(registration && /^[a-f0-9]{32}$/.test(registration.id));
      assert.equal(registration.root, root);
      assert.equal(registration.file, path.join(process.env.HOME, '.cache/rex-test-tasks', `${registration.id}.json`));
      const directory = fs.lstatSync(path.dirname(registration.file));
      assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === uid && (directory.mode & 0o7777) === 0o700);
      const record = read(registration.file);
      assert.equal(record.id, registration.id);
      verifyStartupHandoff(manifest, record, children, rootStat, uid);
      for (const key of ['root', 'endpoint', 'deadline', 'ownerPid', 'ownerIdentity', 'supervisorPid', 'supervisorIdentity']) {
        assert.deepEqual(manifest[key], initial[key], `Bootstrap authority changed: ${key}`);
      }
      const socket = fs.lstatSync(path.join(root, 'server.sock'));
      assert(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === uid && (socket.mode & 0o7777) === 0o600);
      assert.equal(socket.dev, manifest.socketIdentity.dev); assert.equal(socket.ino, manifest.socketIdentity.ino);
      for (const role of ['server', 'controller']) {
        const result = spawnSync('/bin/ps', ['-p', String(children.get(role).pid), '-o', 'uid=,lstart='], { encoding: 'utf8', timeout: 1000, env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
        assert(!result.error && result.status === 0);
        assert.equal(result.stdout.trim().replace(/\s+/g, ' '), manifest[`${role}Identity`]);
      }
      assert(Date.now() < deadline && process.connected, 'Handoff lost its supervisor or deadline');
      assert.deepEqual(read(registration.file), record);
      assert.deepEqual(read(path.join(root, 'manifest.json')), manifest);
      write('startup-handoff.json', { root, guardPid: process.pid, registration: registration.id });
      handedOff = true; clearTimeout(timer);
      for (const child of children.values()) child.unref();
      process.send({ id: message.id, result: { handedOff: true } }, () => process.disconnect());
    } catch (error) { reply(message.id, null, String(error)); await stop('guard-error'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) await serve(process.argv[2]);
