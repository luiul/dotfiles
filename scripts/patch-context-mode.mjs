#!/usr/bin/env node
// Version-pinned local resource patch. Defaults to a read-only integrity check.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transforms } from '../pi/.pi/agent/patches/context-mode/transforms.mjs';

export const VERSION = '1.0.169';
export const REVISION = 'context-mode-resources-v2';
const BUN = '/opt/homebrew/bin/bun';
const BUN_VERSION = '1.3.14';
const BASELINE = '2cdd2def7ef24c1cc594d59b04dd4d1f74f729b7f0bbdf8f7405678fb4a87a76';
const EXPECTED_PATCHED = {
  'build/adapters/pi/mcp-bridge.js': '8b74b8953fe848bd44c155140d871c79c9eb859dfba9afe1d4369151af6ccb2e',
  'build/executor.js': 'e87e296fe9053ba051b4a42f2f738e1538e9d9b482380b40bc25592504861431',
  'build/server.js': '2de8b2ff88da3c02601e612bd54b3102334af46acbe73aa41c6c46765bdfd4eb',
  'build/lifecycle.js': '90b3d6c07e0b419ed971426941fa3adcd5532d92fd11eaad63f80269f89f6604',
  'server.bundle.mjs': '0bdae90524baf36fd55fdd7ef12a212a3778abf892138ae6df1c00bf1fcda295',
};
// Only these explicit historical hashes can migrate to the current revision.
// Keep this v1 entry separate from the current revision's hash set.
export const LEGACY_PATCHES = [{ revision: 'context-mode-resources-v1', files: {
  'build/adapters/pi/mcp-bridge.js': '8b74b8953fe848bd44c155140d871c79c9eb859dfba9afe1d4369151af6ccb2e',
  'build/executor.js': '6972287a89d81f0ca99f919ad6ebdcea69ceebe677c4688ccf59c67e153969bb',
  'build/server.js': '2de8b2ff88da3c02601e612bd54b3102334af46acbe73aa41c6c46765bdfd4eb',
  'build/lifecycle.js': '90b3d6c07e0b419ed971426941fa3adcd5532d92fd11eaad63f80269f89f6604',
  'server.bundle.mjs': '4f094d40464cf4dd1ecac65e5b23b4706ee003ba481668b5d12a6ac18b94ef8c',
} }];
const MARKER = '.pi-resource-patch.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE = path.join(os.homedir(), '.pi/agent/npm/node_modules/context-mode');
export const DEFAULT_CACHE = path.join(os.homedir(), '.cache/pi-resource-patches/context-mode');
const changed = [...Object.keys(transforms), 'server.bundle.mjs'].sort();
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = obj => JSON.stringify(obj, null, 2) + '\n';
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel + '/');
    if (entry.isSymbolicLink()) throw new Error('Refusing symlink in build tree');
    return rel.endsWith('.js') ? [rel] : [];
  });
}
function hashes(pkg) {
  const names = ['package.json', 'server.bundle.mjs', ...walk(path.join(pkg, 'build')).map(p => 'build/' + p)].sort();
  return Object.fromEntries(names.map(name => {
    const file = path.join(pkg, name);
    noLinks(file);
    if (!fs.lstatSync(file).isFile()) throw new Error('Refusing non-file patch input');
    return [name, sha(fs.readFileSync(file))];
  }));
}
function originalsValid(current, manifest) {
  const original = { ...current };
  for (const name of changed) original[name] = manifest.originals[name];
  return sha(JSON.stringify(original)) === BASELINE;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileKeys = obj => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join() === changed.join();
function manifestFor(originals, files, revision = REVISION) {
  return { revision, patchVersion: 1, version: VERSION, baseline: BASELINE, bunVersion: BUN_VERSION, originals, files };
}
function approvedFiles(revision) {
  return revision === REVISION ? EXPECTED_PATCHED : LEGACY_PATCHES.find(p => p.revision === revision)?.files;
}
function validateMarker(bytes, current) {
  const manifest = JSON.parse(bytes);
  const approved = approvedFiles(manifest.revision);
  if (!approved || manifest.version !== VERSION || manifest.patchVersion !== 1 || manifest.baseline !== BASELINE ||
      manifest.bunVersion !== BUN_VERSION || !fileKeys(manifest.files) || !fileKeys(manifest.originals) ||
      !originalsValid(current, manifest) || changed.some(n => current[n] !== manifest.files[n] || current[n] !== approved[n]))
    throw new Error('Patched package marker or file drift');
  if (bytes !== json(manifestFor(manifest.originals, manifest.files, manifest.revision))) throw new Error('Patch marker drift');
  return manifest;
}
export function inspect(pkg) {
  pkg = fs.realpathSync(pkg);
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  if (metadata.name !== 'context-mode' || metadata.version !== VERSION) throw new Error('Unknown context-mode version');
  const current = hashes(pkg);
  const bytes = markerBytes(pkg);
  if (bytes === null) {
    if (sha(JSON.stringify(current)) !== BASELINE) throw new Error('Unpatched package drift');
    return { state: 'original', pkg, current };
  }
  const manifest = validateMarker(bytes, current);
  return { state: 'patched', pkg, current, manifest, legacy: manifest.revision !== REVISION };
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}
function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomic(file, bytes, mode = 0o600) {
  const temp = file + '.resource-' + crypto.randomBytes(8).toString('hex');
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    syncDir(path.dirname(file));
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function noLinks(file) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) {
        // macOS uses these root-owned OS aliases for its temporary directories.
        const systemAlias = process.platform === 'darwin' && ['/var', '/tmp'].includes(p) &&
          stat.uid === 0 && fs.realpathSync(p) === '/private' + p;
        if (!systemAlias) throw new Error('Refusing symlink path: ' + p);
      }
    }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (path.dirname(p) === p) break;
  }
}
function privatePath(file, directory = false) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1))
    throw new Error('Refusing non-private cache path: ' + file);
  return stat;
}
function prepareCache(cache) {
  noLinks(cache);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  privatePath(cache, true);
}
export function baselineDir(cache) { return path.join(cache, VERSION + '-' + BASELINE); }
export function transactionPath(pkg, cache) { return path.join(cache, '.transaction-' + sha(fs.realpathSync(pkg)) + '.json'); }
function packageIdentity(pkg) {
  const stat = fs.statSync(pkg);
  return { path: pkg, dev: stat.dev, ino: stat.ino, version: VERSION, baseline: BASELINE };
}
export function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Ambiguous lock owner PID');
  // lstart and uid supplement the PID. A reused, live PID is still never stolen.
  try {
    const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,uid=,lstart='],
      { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8', stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } }).trim();
    if (!value) throw new Error('Ambiguous process identity');
    return value.replace(/\s+/g, ' ');
  } catch (err) {
    if (err.status === 1 && String(err.stdout ?? '').trim() === '' && String(err.stderr ?? '').trim() === '') {
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') return null; }
    }
    throw new Error('Cannot verify lock owner identity');
  }
}
function acquireLock(pkg, cache) {
  prepareCache(cache);
  const lock = path.join(cache, '.lock-' + sha(pkg));
  const identity = packageIdentity(pkg);
  // Obtain our identity before mkdir, so a failed probe cannot strand an empty lock.
  const selfOwner = { schema: 1, pid: process.pid, uid: process.getuid(), start: processIdentity(), package: identity };
  if (exists(lock)) {
    const stat = privatePath(lock, true);
    const ownerFile = path.join(lock, 'owner.json');
    privatePath(ownerFile);
    const bytes = fs.readFileSync(ownerFile, 'utf8'), owner = JSON.parse(bytes);
    if (bytes !== json(owner) || owner.schema !== 1 || !same(owner.package, identity) ||
        owner.uid !== process.getuid() || typeof owner.start !== 'string' || !owner.start ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 1 ||
        !owner.start.startsWith(`${owner.pid} ${owner.uid} `) ||
        !/^\d+ \d+ [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(owner.start) ||
        fs.readdirSync(lock).sort().join() !== 'owner.json')
      throw new Error('Patch lock exists; ambiguous owner');
    const live = processIdentity(owner.pid);
    if (live !== null) throw new Error('Patch lock exists; live or reused owner identity');
    // Claim inside the old inode before removing it. Competing reclaimers fail closed.
    const claim = path.join(lock, 'recovery-claim.json');
    const fd = fs.openSync(claim, 'wx', 0o600), claimStat = fs.fstatSync(fd);
    try {
      try { fs.writeFileSync(fd, json({ pid: selfOwner.pid, start: selfOwner.start })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      syncDir(lock);
      const now = privatePath(lock, true);
      if (now.dev !== stat.dev || now.ino !== stat.ino || fs.readFileSync(ownerFile, 'utf8') !== bytes ||
          processIdentity(owner.pid) !== null || fs.readdirSync(lock).sort().join() !== 'owner.json,recovery-claim.json')
        throw new Error('Patch lock changed during recovery');
      fs.unlinkSync(ownerFile); fs.unlinkSync(claim); fs.rmdirSync(lock); syncDir(cache);
    } catch (err) {
      // On a handled error, remove only our claim in the unchanged lock and owner.
      // SIGKILL during lock reclamation can leave an ambiguous lock. Never guess then.
      try {
        const now = privatePath(lock, true), savedClaim = privatePath(claim);
        if (now.dev === stat.dev && now.ino === stat.ino && savedClaim.dev === claimStat.dev &&
            savedClaim.ino === claimStat.ino && fs.readFileSync(ownerFile, 'utf8') === bytes) {
          fs.unlinkSync(claim); syncDir(lock);
        }
      } catch { /* Preserve unverified paths for manual review. */ }
      throw err;
    }
  }
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('Patch lock exists; refuse concurrent mutation'); }
  try { atomic(path.join(lock, 'owner.json'), json(selfOwner)); syncDir(cache); }
  catch (err) { if (fs.readdirSync(lock).length === 0) fs.rmdirSync(lock); throw err; }
  const stat = fs.statSync(lock);
  return () => {
    const now = privatePath(lock, true);
    if (now.dev !== stat.dev || now.ino !== stat.ino || fs.readdirSync(lock).join() !== 'owner.json' ||
        fs.readFileSync(path.join(lock, 'owner.json'), 'utf8') !== json(selfOwner)) throw new Error('Lock ownership changed');
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); syncDir(cache);
  };
}
export function copyOriginalPackage(pkg, destination, cache = DEFAULT_CACHE) {
  const state = inspect(pkg);
  if (state.state === 'patched') verifyBackup(baselineDir(cache), state.manifest.originals);
  fs.cpSync(path.join(pkg, 'build'), path.join(destination, 'build'), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'package.json'), path.join(destination, 'package.json'));
  fs.copyFileSync(path.join(pkg, 'server.bundle.mjs'), path.join(destination, 'server.bundle.mjs'));
  if (state.state === 'patched') for (const name of changed) {
    const file = path.join(destination, name);
    fs.copyFileSync(path.join(baselineDir(cache), name), file);
    fs.chmodSync(file, fs.statSync(path.join(pkg, name)).mode & 0o7777);
  }
  if (inspect(destination).state !== 'original') throw new Error('Original reconstruction failed');
  return state;
}
function ensureBackup(pkg, cache, state) {
  const dir = baselineDir(cache);
  prepareCache(cache);
  if (!exists(dir)) {
    const temp = fs.mkdtempSync(path.join(cache, '.baseline-'));
    try {
      for (const name of changed) {
        fs.mkdirSync(path.dirname(path.join(temp, name)), { recursive: true, mode: 0o700 });
        atomic(path.join(temp, name), fs.readFileSync(path.join(pkg, name)));
      }
      atomic(path.join(temp, 'original-hashes.json'), json(Object.fromEntries(changed.map(n => [n, state.current[n]]))));
      for (const sub of ['build', 'build/adapters', 'build/adapters/pi']) syncDir(path.join(temp, sub));
      syncDir(temp);
      fs.renameSync(temp, dir); syncDir(cache);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  verifyBackup(dir, state.manifest?.originals ?? state.current);
  return dir;
}
function verifyBackup(dir, originals) {
  privatePath(dir, true);
  const metadata = path.join(dir, 'original-hashes.json');
  privatePath(metadata);
  const recorded = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  if (!fileKeys(recorded) || changed.some(n => recorded[n] !== originals[n])) throw new Error('Original baseline drift');
  for (const name of changed) {
    const file = path.join(dir, name);
    for (let p = path.dirname(file); p !== dir; p = path.dirname(p)) privatePath(p, true);
    privatePath(file);
    if (sha(fs.readFileSync(file)) !== originals[name]) throw new Error('Original baseline drift');
  }
}
export function stagePackage(pkg, cache = DEFAULT_CACHE) {
  // Sibling staging preserves npm dependency lookup. No source files are changed.
  const stage = fs.mkdtempSync(path.join(path.dirname(pkg), '.context-mode-resource-'));
  try {
    copyOriginalPackage(pkg, stage, cache);
    if (fs.existsSync(path.join(pkg, 'node_modules'))) fs.symlinkSync(path.join(pkg, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
    for (const [name, transform] of Object.entries(transforms)) {
      fs.writeFileSync(path.join(stage, name), transform(fs.readFileSync(path.join(stage, name), 'utf8')));
      execFileSync(process.execPath, ['--check', path.join(stage, name)], { timeout: 10_000, killSignal: 'SIGKILL', stdio: 'pipe' });
    }
    if (execFileSync(BUN, ['--version'], { timeout: 10_000, stdio: 'pipe' }).toString().trim() !== BUN_VERSION)
      throw new Error('Unsupported Bun build version');
    const build = output => execFileSync(BUN, [path.join(ROOT, 'pi/.pi/agent/patches/context-mode/bundle.mjs'), output], {
      cwd: stage, timeout: 30_000, killSignal: 'SIGKILL', stdio: 'pipe'
    });
    build(path.join(stage, 'server.bundle.mjs'));
    build(path.join(stage, 'verify.bundle.mjs'));
    if (sha(fs.readFileSync(path.join(stage, 'server.bundle.mjs'))) !== sha(fs.readFileSync(path.join(stage, 'verify.bundle.mjs'))))
      throw new Error('Bundle is not reproducible');
    fs.unlinkSync(path.join(stage, 'verify.bundle.mjs'));
    return stage;
  } catch (err) { fs.rmSync(stage, { recursive: true, force: true }); throw err; }
}
export async function smoke(pkg) {
  const { MCPStdioClient } = await import(pathToFileURL(path.join(pkg, 'build/adapters/pi/mcp-bridge.js')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-'));
  const env = { ...process.env, HOME: home, PI_CONFIG_DIR: path.join(home, '.pi'), CONTEXT_MODE_PROJECT_DIR: home,
    CONTEXT_MODE_PLATFORM: 'pi', CONTEXT_MODE_BRIDGE_IDLE_MS: '0', PI_SESSION_ID: 'resource-smoke' };
  fs.mkdirSync(env.PI_CONFIG_DIR, { recursive: true });
  const client = new MCPStdioClient(path.join(pkg, 'server.bundle.mjs'), env, process.execPath);
  let child;
  const deadline = setTimeout(() => client.shutdown(new Error('Smoke deadline')), 60_000);
  try {
    client.start(); child = client.child;
    await client.initialize();
    const tools = await client.listTools();
    if (!tools.some(t => t.name === 'ctx_execute') || !tools.some(t => t.name === 'ctx_search')) throw new Error('Smoke missing tools');
    const result = await client.callTool('ctx_execute', { language: 'shell', code: 'printf resource-smoke', timeout: 5000 });
    if (result.isError || !JSON.stringify(result).includes('resource-smoke')) throw new Error('Smoke execution failed');
    const indexed = await client.callTool('ctx_index', { content: '# Resource smoke\n\nResource ownership verification', source: 'resource-smoke' });
    if (indexed.isError) throw new Error('Smoke SQLite indexing failed');
  } finally {
    clearTimeout(deadline);
    client.shutdown();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
      const close = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.removeListener('close', close);
        child.kill('SIGKILL');
        reject(new Error('Smoke shutdown deadline exceeded'));
      }, 7000);
      child.once('close', close);
      if (child.exitCode !== null || child.signalCode !== null) { child.removeListener('close', close); close(); }
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
function markerBytes(pkg) {
  const file = path.join(pkg, MARKER);
  noLinks(file);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Refusing non-file marker');
    return fs.readFileSync(file, 'utf8');
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function versionValid(current, marker) {
  if (marker === null) {
    if (sha(JSON.stringify(current)) !== BASELINE) throw new Error('Transaction original hash drift');
  } else {
    if (typeof marker !== 'string') throw new Error('Transaction marker drift');
    try { validateMarker(marker, current); } catch { throw new Error('Transaction marker or approved file drift'); }
  }
}
function journalBytes(record) { return json({ record, digest: sha(json(record)) }); }
function readJournal(pkg, cache) {
  const file = transactionPath(pkg, cache);
  privatePath(cache, true); privatePath(file);
  const bytes = fs.readFileSync(file, 'utf8');
  let envelope;
  try { envelope = JSON.parse(bytes); } catch { throw new Error('Transaction journal corruption'); }
  const r = envelope.record;
  if (!r || bytes !== journalBytes(r) || envelope.digest !== sha(json(r)) || r.schema !== 1 ||
      !same(r.package, packageIdentity(pkg)) || !['apply', 'restore'].includes(r.operation) ||
      !r.original || !r.before || !r.after || !r.modes ||
      !same(Object.keys(r.original), Object.keys(r.before)) || !same(Object.keys(r.original), Object.keys(r.after)) ||
      !same(Object.keys(r.original), Object.keys(r.modes)) || sha(JSON.stringify(r.original)) !== BASELINE)
    throw new Error('Transaction journal corruption or foreign package');
  // Recorded versions must be approved code, not just hashes supplied by the journal.
  versionValid(r.before, r.markerBefore); versionValid(r.after, r.markerAfter);
  if (r.operation === 'restore' && r.markerAfter !== null || r.operation === 'apply' &&
      (r.markerAfter === null || JSON.parse(r.markerAfter).revision !== REVISION)) throw new Error('Transaction target drift');
  for (const name of Object.keys(r.original)) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').some(p => p === '..' || p === '') || path.isAbsolute(name) ||
        !Number.isInteger(r.modes[name]) || r.modes[name] < 0 || r.modes[name] > 0o7777 ||
        !/^[a-f0-9]{64}$/.test(r.original[name]) ||
        (!changed.includes(name) && (r.before[name] !== r.original[name] || r.after[name] !== r.original[name])))
      throw new Error('Transaction file map drift');
  }
  if (!changed.every(n => Object.hasOwn(r.original, n)) || !Number.isInteger(r.markerMode) || r.markerMode < 0 || r.markerMode > 0o7777)
    throw new Error('Transaction mode drift');
  const current = hashes(pkg);
  if (!same(Object.keys(current), Object.keys(r.original))) throw new Error('Transaction package tree drift');
  for (const name of Object.keys(current)) {
    if (![r.before[name], r.after[name], r.original[name]].includes(current[name]) ||
        (fs.statSync(path.join(pkg, name)).mode & 0o7777) !== r.modes[name]) throw new Error('Transaction package file drift: ' + name);
  }
  const marker = markerBytes(pkg);
  if (![r.markerBefore, r.markerAfter, null].includes(marker) || marker !== null &&
      (fs.statSync(path.join(pkg, MARKER)).mode & 0o7777) !== r.markerMode) throw new Error('Transaction current marker drift');
  verifyBackup(baselineDir(cache), r.original);
  return { record: r, bytes };
}
function clearJournal(pkg, cache, bytes) {
  const file = transactionPath(pkg, cache);
  privatePath(file);
  if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('Transaction journal changed');
  fs.unlinkSync(file); syncDir(cache);
}
function replaceMarker(pkg, bytes, mode, onReplace, phase) {
  const file = path.join(pkg, MARKER);
  if (bytes === null) { if (markerBytes(pkg) !== null) { fs.unlinkSync(file); syncDir(pkg); } }
  else atomic(file, bytes, mode);
  onReplace?.({ phase, name: MARKER });
}
function recoverTransaction(pkg, cache, onReplace) {
  const { record: r, bytes } = readJournal(pkg, cache);
  // Full validation happens before the first replacement. Retain the journal on failure.
  for (const name of changed) {
    atomic(path.join(pkg, name), fs.readFileSync(path.join(baselineDir(cache), name)), r.modes[name]);
    onReplace?.({ phase: 'recover', name });
  }
  replaceMarker(pkg, null, r.markerMode, onReplace, 'recover');
  if (inspect(pkg).state !== 'original') throw new Error('Transaction recovery failed');
  clearJournal(pkg, cache, bytes);
}
function beginTransaction(pkg, cache, state, operation, files, markerAfter) {
  const original = { ...state.current, ...(state.manifest?.originals ?? {}) };
  const markerBefore = markerBytes(pkg);
  const r = { schema: 1, package: packageIdentity(pkg), operation, original, before: state.current,
    after: { ...original, ...files }, markerBefore, markerAfter,
    modes: Object.fromEntries(Object.keys(original).map(n => [n, fs.statSync(path.join(pkg, n)).mode & 0o7777])),
    markerMode: markerBefore === null ? 0o600 : fs.statSync(path.join(pkg, MARKER)).mode & 0o7777 };
  const file = transactionPath(pkg, cache);
  if (exists(file)) throw new Error('Transaction already exists');
  // Publish and fsync the journal and its directory before any package rename.
  atomic(file, journalBytes(r));
  return readJournal(pkg, cache);
}
export async function patch({ mode = 'check', packageDir = DEFAULT_PACKAGE, cacheDir = DEFAULT_CACHE, onReplace } = {}) {
  if (!['check', 'apply', 'restore'].includes(mode)) throw new Error('Unknown mode');
  const pkg = fs.realpathSync(packageDir);
  cacheDir = path.resolve(cacheDir);
  noLinks(cacheDir);
  const pending = exists(transactionPath(pkg, cacheDir));
  if (mode === 'check') {
    if (pending) throw new Error('Interrupted transaction needs apply or restore recovery');
    const state = inspect(pkg);
    return { version: VERSION, revision: REVISION, state: state.state, files: changed.length, valid: true,
      ...(state.legacy ? { installedRevision: state.manifest.revision, migrationRequired: true } : {}) };
  }
  // Unknown drift without a recorded transaction fails before even creating the cache.
  if (!pending) inspect(pkg);
  const release = acquireLock(pkg, cacheDir);
  let stage, recovered = false;
  try {
    if (exists(transactionPath(pkg, cacheDir))) {
      recoverTransaction(pkg, cacheDir, onReplace); recovered = true;
    }
    const state = inspect(pkg);
    if (mode === 'apply' && state.state === 'patched' && !state.legacy || mode === 'restore' && state.state === 'original')
      return { version: VERSION, revision: REVISION, state: state.state, unchanged: true, recovered };
    let files = {}, markerAfter = null, input = baselineDir(cacheDir);
    if (mode === 'apply') {
      stage = stagePackage(pkg, cacheDir);
      await smoke(stage);
      const fresh = inspect(pkg);
      if (!same(fresh.current, state.current) || markerBytes(pkg) !== (state.manifest ? json(state.manifest) : null))
        throw new Error('Package changed while staging');
      files = Object.fromEntries(changed.map(n => [n, sha(fs.readFileSync(path.join(stage, n)))]));
      if (changed.some(n => files[n] !== EXPECTED_PATCHED[n])) throw new Error('Generated patch hash drift');
      const originals = state.manifest?.originals ?? Object.fromEntries(changed.map(n => [n, state.current[n]]));
      if (state.state === 'original') ensureBackup(pkg, cacheDir, state);
      else verifyBackup(input, originals);
      markerAfter = json(manifestFor(originals, files));
      input = stage;
    } else verifyBackup(input, state.manifest.originals);
    const { record: r, bytes } = beginTransaction(pkg, cacheDir, state, mode, files, markerAfter);
    // Errors and hard interruptions both leave the same recoverable, validated journal.
    for (const name of changed) {
      atomic(path.join(pkg, name), fs.readFileSync(path.join(input, name)), r.modes[name]);
      onReplace?.({ phase: mode, name });
    }
    replaceMarker(pkg, markerAfter, r.markerMode, onReplace, mode);
    const final = inspect(pkg);
    clearJournal(pkg, cacheDir, bytes);
    return { version: VERSION, revision: REVISION, state: final.state, files: changed.length, recovered,
      smoke: mode === 'apply' ? 'passed' : undefined };
  } finally {
    try { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
    finally { release(); }
  }
}
export function parseArgs(args) {
  const options = {}; let setMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--check', '--apply', '--restore'].includes(arg)) {
      if (setMode) throw new Error('Choose one mode');
      options.mode = arg.slice(2); setMode = true;
    } else if (arg === '--package-dir' || arg === '--cache-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing path argument');
      options[arg === '--package-dir' ? 'packageDir' : 'cacheDir'] = path.resolve(args[++i]);
    } else throw new Error('Unknown argument');
  }
  return options;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await patch(parseArgs(process.argv.slice(2))))); }
  catch (err) { console.error(JSON.stringify({ error: err instanceof Error ? err.message : 'Patch failed' })); process.exitCode = 1; }
}
