#!/usr/bin/env node
// Private fixtures only. Every child and the suite have hard deadlines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patch, inspect, copyOriginalPackage, baselineDir, DEFAULT_CACHE, sha, REVISION,
  LEGACY_PATCHES, transactionPath, processIdentity, VERSION } from './patch-context-mode.mjs';

const self = fileURLToPath(import.meta.url);
const markerName = '.pi-resource-patch.json';
const json = value => JSON.stringify(value, null, 2) + '\n';
if (process.argv[2] === '--child') {
  const options = JSON.parse(process.argv[3]);
  let count = 0;
  // Fail an owned claim fsync once, then verify the handled error removes only that claim.
  if (options.failClaimSync) {
    const open = fs.openSync, sync = fs.fsyncSync;
    let claimFd;
    fs.openSync = (...args) => { const fd = open(...args); if (String(args[0]).endsWith('/recovery-claim.json')) claimFd = fd; return fd; };
    fs.fsyncSync = fd => {
      if (fd === claimFd) { claimFd = undefined; throw new Error('Injected claim fsync failure'); }
      return sync(fd);
    };
  }
  try {
    const result = await patch({ ...options, onReplace({ phase }) {
      if (phase === options.mode && ++count === options.crashAt) process.kill(process.pid, 'SIGKILL');
      if (phase === 'recover' && options.recoveryCrashAt && ++count === options.recoveryCrashAt) process.kill(process.pid, 'SIGKILL');
    } });
    console.log(json(result));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
} else {
  const source = process.argv[2] ?? path.join(os.homedir(), '.pi/agent/npm/node_modules/context-mode');
  const sourceCache = process.argv[3] ?? DEFAULT_CACHE;
  const legacySource = process.argv[4] ?? source;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-patch-recovery-'));
  const base = path.join(temp, 'original');
  const children = new Set();
  const passed = [];
  const suiteMs = 600_000;
  const stop = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; } };
  const deadline = setTimeout(() => {
    for (const child of children) stop(child);
    console.error('Recovery suite deadline exceeded');
    fs.rmSync(temp, { recursive: true, force: true });
    process.exit(1);
  }, suiteMs);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function launch(options) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [self, '--child', JSON.stringify(options)], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTEXT_MODE_BRIDGE_DEPTH: '0' },
      });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16384); });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
      const timer = setTimeout(() => { stop(child); }, 100_000);
      child.once('error', err => { clearTimeout(timer); children.delete(child); reject(err); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); children.delete(child);
        // Reclaim any test-owned descendants if a hard crash occurred.
        stop(child);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }
  async function success(options) {
    const result = await launch(options);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  async function crash(fixture, mode, at, extra = {}) {
    const result = await launch({ ...fixture, mode, crashAt: at, ...extra });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert(fs.existsSync(transactionPath(fixture.packageDir, fixture.cacheDir)));
  }
  function snapshot(root) {
    if (!fs.existsSync(root)) return null;
    const entries = {};
    function visit(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + entry.name, file = path.join(dir, entry.name), stat = fs.lstatSync(file);
        entries[name] = { mode: stat.mode & 0o7777, data: entry.isSymbolicLink() ? fs.readlinkSync(file) : entry.isFile() ? sha(fs.readFileSync(file)) : 'directory' };
        if (entry.isDirectory()) visit(file, name + '/');
      }
    }
    visit(root);
    return entries;
  }
  function fixture(name, template = base) {
    const root = path.join(temp, name); fs.mkdirSync(root);
    const packageDir = path.join(root, 'context-mode'), cacheDir = path.join(root, 'cache');
    fs.cpSync(template, packageDir, { recursive: true, dereference: false, verbatimSymlinks: true });
    if (!fs.existsSync(path.join(packageDir, 'node_modules')) && fs.existsSync(path.join(source, 'node_modules')))
      fs.symlinkSync(path.join(source, 'node_modules'), path.join(packageDir, 'node_modules'), 'dir');
    return { packageDir, cacheDir };
  }
  function cloneFixture(name, from) {
    const to = fixture(name, from.packageDir);
    fs.cpSync(from.cacheDir, to.cacheDir, { recursive: true });
    fs.chmodSync(to.cacheDir, 0o700);
    const oldFile = transactionPath(from.packageDir, from.cacheDir), newFile = transactionPath(to.packageDir, to.cacheDir);
    const envelope = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const stat = fs.statSync(to.packageDir);
    envelope.record.package = { ...envelope.record.package, path: fs.realpathSync(to.packageDir), dev: stat.dev, ino: stat.ino };
    envelope.digest = sha(json(envelope.record));
    fs.unlinkSync(path.join(to.cacheDir, path.basename(oldFile)));
    fs.writeFileSync(newFile, json(envelope), { mode: 0o600 });
    // The cloned dead lock is foreign. Only test-owned copied records are removed here.
    for (const name of fs.readdirSync(to.cacheDir).filter(n => n.startsWith('.lock-')))
      fs.rmSync(path.join(to.cacheDir, name), { recursive: true });
    return to;
  }
  async function refusal(f, mutate, pattern = /drift|journal|private|symlink|lock|identity|baseline|version|transaction/i) {
    await mutate?.();
    const packageBefore = snapshot(f.packageDir);
    const cacheBefore = snapshot(f.cacheDir);
    const result = await launch({ ...f, mode: 'restore' });
    assert.notEqual(result.code, 0, 'Unexpected recovery success');
    assert.match(result.stderr, pattern);
    assert.deepEqual(snapshot(f.packageDir), packageBefore, 'Rejected recovery changed package');
    assert.deepEqual(snapshot(f.cacheDir), cacheBefore, 'Rejected recovery changed cache contents');
  }
  async function test(name, run) { await run(); passed.push(name); console.log('PASS ' + name); }
  let baseline;
  try {
    copyOriginalPackage(source, base, sourceCache);
    fs.symlinkSync(path.dirname(source), path.join(temp, 'node_modules'), 'dir');
    baseline = inspect(base).current;
    // Nondefault permissions prove replacement does not silently reset package file modes.
    fs.chmodSync(path.join(base, 'build/executor.js'), 0o1751);
    const originalModes = Object.fromEntries(Object.keys(baseline).map(n => [n, fs.statSync(path.join(base, n)).mode & 0o7777]));
    await test('check is read-only with no cache or lock', async () => {
      const f = fixture('check');
      const before = snapshot(f.packageDir);
      assert.equal((await success({ ...f, mode: 'check' })).state, 'original');
      assert.deepEqual(snapshot(f.packageDir), before); assert.equal(fs.existsSync(f.cacheDir), false);
    });
    const seed = fixture('seed');
    await test('apply, restore, backups, and package permissions', async () => {
      assert.equal((await success({ ...seed, mode: 'apply' })).smoke, 'passed');
      assert.equal(inspect(seed.packageDir).manifest.revision, REVISION);
      for (const [n, mode] of Object.entries(originalModes)) assert.equal(fs.statSync(path.join(seed.packageDir, n)).mode & 0o7777, mode);
      assert.equal(fs.statSync(seed.cacheDir).mode & 0o777, 0o700);
    });
    const names = [...Object.keys(inspect(seed.packageDir).manifest.files)].sort();
    let partial;
    for (const mode of ['apply', 'restore']) {
      for (let at = 1; at <= names.length + 1; at++) {
        await test(`${mode} child crash after replacement ${at} recovers originals`, async () => {
          const f = fixture(`${mode}-${at}`, mode === 'restore' ? seed.packageDir : base);
          if (mode === 'restore') fs.cpSync(seed.cacheDir, f.cacheDir, { recursive: true });
          await crash(f, mode, at);
          const packageBefore = snapshot(f.packageDir), cacheBefore = snapshot(f.cacheDir);
          const check = await launch({ ...f, mode: 'check' });
          assert.notEqual(check.code, 0); assert.match(check.stderr, /Interrupted transaction/);
          assert.deepEqual(snapshot(f.packageDir), packageBefore); assert.deepEqual(snapshot(f.cacheDir), cacheBefore);
          if (mode === 'apply' && at === 1) partial = cloneFixture('partial-seed', f);
          assert.equal((await success({ ...f, mode: 'restore' })).recovered, true);
          assert.deepEqual(inspect(f.packageDir).current, baseline);
          assert.equal(fs.existsSync(transactionPath(f.packageDir, f.cacheDir)), false);
          assert.equal(fs.readdirSync(f.cacheDir).some(n => n.startsWith('.lock-')), false);
          for (const [n, value] of Object.entries(originalModes)) assert.equal(fs.statSync(path.join(f.packageDir, n)).mode & 0o7777, value);
        });
      }
    }
    await test('apply recovers a partial transaction before rebuilding v2', async () => {
      const f = cloneFixture('recover-apply', partial);
      const result = await success({ ...f, mode: 'apply' });
      assert.equal(result.recovered, true); assert.equal(result.state, 'patched');
      await success({ ...f, mode: 'restore' });
    });
    await test('recovery itself is interruptible and repeatable', async () => {
      const f = cloneFixture('recover-crash', partial);
      await crash(f, 'restore', 0, { recoveryCrashAt: 2 });
      assert.equal((await success({ ...f, mode: 'restore' })).recovered, true);
      assert.deepEqual(inspect(f.packageDir).current, baseline);
    });
    await test('corrupt journal, foreign identity, forged known hashes, and marker bytes fail closed', async () => {
      const mutations = [
        file => fs.appendFileSync(file, 'garbage'),
        file => { const e = JSON.parse(fs.readFileSync(file)); e.record.package.ino++; e.digest = sha(json(e.record)); fs.writeFileSync(file, json(e)); },
        file => { const e = JSON.parse(fs.readFileSync(file)); e.record.after[names[0]] = 'a'.repeat(64); e.digest = sha(json(e.record)); fs.writeFileSync(file, json(e)); },
        file => { const e = JSON.parse(fs.readFileSync(file)); e.record.markerAfter += ' '; e.digest = sha(json(e.record)); fs.writeFileSync(file, json(e)); },
      ];
      for (const [i, mutate] of mutations.entries()) {
        const f = cloneFixture('bad-journal-' + i, partial);
        await refusal(f, () => mutate(transactionPath(f.packageDir, f.cacheDir)));
      }
    });
    await test('changed source, untouched source, saved originals, marker, and file modes fail closed', async () => {
      const untouched = Object.keys(baseline).find(n => !names.includes(n) && n !== 'package.json');
      const targets = [f => path.join(f.packageDir, names[0]), f => path.join(f.packageDir, untouched),
        f => path.join(baselineDir(f.cacheDir), names[0]), f => path.join(f.packageDir, markerName)];
      for (const [i, target] of targets.entries()) {
        const f = cloneFixture('tamper-' + i, partial);
        await refusal(f, () => fs.appendFileSync(target(f), '// arbitrary source', { mode: 0o600 }));
      }
      const f = cloneFixture('mode-tamper', partial);
      await refusal(f, () => fs.chmodSync(path.join(f.packageDir, names[0]), 0o777));
    });
    await test('cache, baseline parent, and journal symlinks fail closed without touching targets', async () => {
      for (const kind of ['cache', 'parent', 'journal']) {
        const f = cloneFixture('symlink-' + kind, partial);
        const link = kind === 'cache' ? f.cacheDir : kind === 'parent' ? path.join(baselineDir(f.cacheDir), 'build') : transactionPath(f.packageDir, f.cacheDir);
        const target = link + '-target'; fs.renameSync(link, target); fs.symlinkSync(target, link);
        const before = snapshot(path.dirname(target));
        await refusal(f);
        assert.deepEqual(snapshot(path.dirname(target)), before);
      }
    });
    await test('journal private permissions and hard links fail closed', async () => {
      for (const kind of ['permissions', 'hardlink']) {
        const f = cloneFixture('journal-' + kind, partial), file = transactionPath(f.packageDir, f.cacheDir);
        await refusal(f, () => kind === 'permissions' ? fs.chmodSync(file, 0o644) : fs.linkSync(file, file + '.user-file'));
      }
    });
    await test('dangling journal and marker symlinks are never replaced or ignored', async () => {
      for (const kind of ['journal', 'marker']) {
        const f = fixture('dangling-' + kind);
        const link = kind === 'journal' ? transactionPath(f.packageDir, f.cacheDir) : path.join(f.packageDir, markerName);
        fs.mkdirSync(f.cacheDir, { mode: 0o700 });
        fs.symlinkSync(path.join(temp, 'user-missing-target'), link);
        await refusal(f);
      }
    });
    await test('arbitrary drift without a journal cannot restore', async () => {
      const f = fixture('arbitrary');
      await refusal(f, () => fs.appendFileSync(path.join(f.packageDir, names[0]), '// unknown'));
      assert.equal(fs.existsSync(f.cacheDir), false);
    });
    await test('live, reused, ambiguous, and foreign lock owners are not stolen', async () => {
      for (const kind of ['live', 'reused', 'ambiguous', 'foreign']) {
        const f = cloneFixture('lock-' + kind, partial), pkg = fs.realpathSync(f.packageDir), stat = fs.statSync(pkg);
        const lock = path.join(f.cacheDir, '.lock-' + sha(pkg)); fs.mkdirSync(lock, { mode: 0o700 });
        const owner = { schema: 1, pid: process.pid, uid: process.getuid(), start: processIdentity(),
          package: { path: pkg, dev: stat.dev, ino: stat.ino, version: VERSION,
            baseline: JSON.parse(fs.readFileSync(transactionPath(f.packageDir, f.cacheDir))).record.package.baseline } };
        if (kind === 'reused') owner.start = owner.start.replace(/\d{4}$/, '1999');
        if (kind === 'ambiguous') owner.start = 'unknown';
        if (kind === 'foreign') owner.package.ino++;
        fs.writeFileSync(path.join(lock, 'owner.json'), json(owner), { mode: 0o600 });
        await refusal(f, undefined, /lock exists/i);
      }
    });
    await test('handled dead-lock claim fsync failure removes only its owned claim', async () => {
      const f = fixture('claim-failure');
      await crash(f, 'apply', 1);
      const packageBefore = snapshot(f.packageDir), cacheBefore = snapshot(f.cacheDir);
      const result = await launch({ ...f, mode: 'restore', failClaimSync: true });
      assert.notEqual(result.code, 0); assert.match(result.stderr, /Injected claim fsync failure/);
      assert.deepEqual(snapshot(f.packageDir), packageBefore);
      assert.deepEqual(snapshot(f.cacheDir), cacheBefore);
      assert.equal((await success({ ...f, mode: 'restore' })).recovered, true);
    });
    await test('actual concurrent live installer is refused', async () => {
      const f = fixture('concurrent');
      const first = launch({ ...f, mode: 'apply' });
      const lock = path.join(f.cacheDir, '.lock-' + sha(fs.realpathSync(f.packageDir)));
      const end = Date.now() + 10_000;
      while (!fs.existsSync(path.join(lock, 'owner.json')) && Date.now() < end) await sleep(25);
      assert(fs.existsSync(path.join(lock, 'owner.json')));
      const second = await launch({ ...f, mode: 'apply' });
      assert.notEqual(second.code, 0); assert.match(second.stderr, /lock exists/i);
      const result = await first; assert.equal(result.code, 0, result.stderr);
      await success({ ...f, mode: 'restore' });
    });
    await test('approved v1 migration stages originals and replaces v1 with v2', async () => {
      const state = inspect(legacySource);
      assert.equal(state.manifest?.revision, LEGACY_PATCHES[0].revision, 'Pass a verified installed v1 package as the fourth argument');
      const f = fixture('migration', legacySource);
      fs.cpSync(baselineDir(sourceCache), baselineDir(f.cacheDir), { recursive: true });
      fs.chmodSync(f.cacheDir, 0o700);
      fs.chmodSync(path.join(f.packageDir, 'build/executor.js'), 0o1751);
      fs.chmodSync(path.join(f.packageDir, markerName), 0o640);
      const migrationModes = Object.fromEntries(Object.keys(baseline).map(n => [n, fs.statSync(path.join(f.packageDir, n)).mode & 0o7777]));
      const reconstructed = path.join(temp, 'legacy-reconstructed');
      copyOriginalPackage(f.packageDir, reconstructed, f.cacheDir);
      assert.deepEqual(inspect(reconstructed).current, baseline);
      for (const [n, mode] of Object.entries(migrationModes)) assert.equal(fs.statSync(path.join(reconstructed, n)).mode & 0o7777, mode);
      assert.equal(inspect(f.packageDir).legacy, true);
      const before = snapshot(f.packageDir);
      const result = await success({ ...f, mode: 'check' });
      assert.equal(result.migrationRequired, true); assert.deepEqual(snapshot(f.packageDir), before);
      // Migration recovery accepts baseline bytes in addition to v1 and v2 bytes.
      const interrupted = fixture('migration-crash', legacySource);
      fs.cpSync(baselineDir(sourceCache), baselineDir(interrupted.cacheDir), { recursive: true });
      fs.chmodSync(interrupted.cacheDir, 0o700);
      await crash(interrupted, 'apply', 2);
      await crash(interrupted, 'restore', 0, { recoveryCrashAt: 2 });
      assert.equal((await success({ ...interrupted, mode: 'restore' })).recovered, true);
      assert.deepEqual(inspect(interrupted.packageDir).current, baseline);
      assert.equal((await success({ ...f, mode: 'apply' })).state, 'patched');
      assert.equal(inspect(f.packageDir).manifest.revision, REVISION);
      for (const [n, mode] of Object.entries(migrationModes)) assert.equal(fs.statSync(path.join(f.packageDir, n)).mode & 0o7777, mode);
      assert.equal(fs.statSync(path.join(f.packageDir, markerName)).mode & 0o7777, 0o640);
      await success({ ...f, mode: 'restore' });
      assert.deepEqual(inspect(f.packageDir).current, baseline);
      for (const [n, mode] of Object.entries(migrationModes)) assert.equal(fs.statSync(path.join(f.packageDir, n)).mode & 0o7777, mode);
    });
    await success({ ...seed, mode: 'restore' });
    console.log(json({ passed: passed.length, suiteDeadlineMs: suiteMs, privateFixtures: true }));
  } finally {
    clearTimeout(deadline);
    for (const child of children) stop(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
