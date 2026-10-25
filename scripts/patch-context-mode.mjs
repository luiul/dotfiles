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
export const REVISION = 'context-mode-resources-v1';
const BUN = '/opt/homebrew/bin/bun';
const BUN_VERSION = '1.3.14';
const BASELINE = '2cdd2def7ef24c1cc594d59b04dd4d1f74f729b7f0bbdf8f7405678fb4a87a76';
const EXPECTED_PATCHED = {
  'build/adapters/pi/mcp-bridge.js': '8b74b8953fe848bd44c155140d871c79c9eb859dfba9afe1d4369151af6ccb2e',
  'build/executor.js': '6972287a89d81f0ca99f919ad6ebdcea69ceebe677c4688ccf59c67e153969bb',
  'build/server.js': '2de8b2ff88da3c02601e612bd54b3102334af46acbe73aa41c6c46765bdfd4eb',
  'build/lifecycle.js': '90b3d6c07e0b419ed971426941fa3adcd5532d92fd11eaad63f80269f89f6604',
  'server.bundle.mjs': '4f094d40464cf4dd1ecac65e5b23b4706ee003ba481668b5d12a6ac18b94ef8c',
};
const MARKER = '.pi-resource-patch.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE = path.join(os.homedir(), '.pi/agent/npm/node_modules/context-mode');
export const DEFAULT_CACHE = path.join(os.homedir(), '.cache/pi-resource-patches/context-mode');
const changed = [...Object.keys(transforms), 'server.bundle.mjs'];
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
    if (!fs.lstatSync(file).isFile()) throw new Error('Refusing non-file patch input');
    return [name, sha(fs.readFileSync(file))];
  }));
}
function originalsValid(pkg, current, manifest) {
  const original = { ...current };
  for (const name of changed) original[name] = manifest.originals[name];
  return sha(JSON.stringify(original)) === BASELINE;
}
export function inspect(pkg) {
  pkg = fs.realpathSync(pkg);
  const metadata = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  if (metadata.name !== 'context-mode' || metadata.version !== VERSION) throw new Error('Unknown context-mode version');
  const current = hashes(pkg);
  const marker = path.join(pkg, MARKER);
  if (!fs.existsSync(marker)) {
    if (sha(JSON.stringify(current)) !== BASELINE) throw new Error('Unpatched package drift');
    return { state: 'original', pkg, current };
  }
  if (!fs.lstatSync(marker).isFile()) throw new Error('Refusing non-file marker');
  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (manifest.revision !== REVISION || manifest.version !== VERSION || manifest.patchVersion !== 1 ||
      manifest.baseline !== BASELINE || manifest.bunVersion !== BUN_VERSION ||
      Object.keys(manifest.files).sort().join() !== changed.sort().join() ||
      Object.keys(manifest.originals).sort().join() !== changed.sort().join() ||
      !originalsValid(pkg, current, manifest) ||
      changed.some(name => current[name] !== manifest.files[name] || current[name] !== EXPECTED_PATCHED[name])) throw new Error('Patched package marker or file drift');
  const expected = { revision: REVISION, patchVersion: 1, version: VERSION, baseline: BASELINE,
    bunVersion: BUN_VERSION, originals: manifest.originals, files: manifest.files };
  if (fs.readFileSync(marker, 'utf8') !== json(expected)) throw new Error('Patch marker drift');
  return { state: 'patched', pkg, current, manifest };
}
function atomic(file, bytes, mode = 0o600) {
  const temp = file + '.resource-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp, bytes, { mode, flag: 'wx' });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function baselineDir(cache) { return path.join(cache, VERSION + '-' + BASELINE); }
function acquireLock(pkg, cache) {
  // A leftover lock is never stolen by PID. Fail closed until reviewed manually.
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error('Refusing symlink cache');
  fs.chmodSync(cache, 0o700);
  const lock = path.join(cache, '.lock-' + sha(pkg));
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('Patch lock exists; refuse concurrent mutation (review any stale lock manually)'); }
  try { atomic(path.join(lock, 'owner.json'), json({ pid: process.pid, createdAt: new Date().toISOString(), packageHash: sha(pkg) })); }
  catch (err) { fs.rmdirSync(lock); throw err; }
  return () => { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); };
}
export function copyOriginalPackage(pkg, destination, cache = DEFAULT_CACHE) {
  const state = inspect(pkg);
  if (state.state === 'patched') verifyBackup(baselineDir(cache), state.manifest.originals);
  fs.cpSync(path.join(pkg, 'build'), path.join(destination, 'build'), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'package.json'), path.join(destination, 'package.json'));
  fs.copyFileSync(path.join(pkg, 'server.bundle.mjs'), path.join(destination, 'server.bundle.mjs'));
  if (state.state === 'patched') for (const name of changed)
    fs.copyFileSync(path.join(baselineDir(cache), name), path.join(destination, name));
  if (inspect(destination).state !== 'original') throw new Error('Original reconstruction failed');
  return state;
}
function ensureBackup(pkg, cache, state) {
  const dir = baselineDir(cache);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error('Refusing symlink cache');
  fs.chmodSync(cache, 0o700);
  if (!fs.existsSync(dir)) {
    const temp = fs.mkdtempSync(path.join(cache, '.baseline-'));
    try {
      for (const name of changed) {
        fs.mkdirSync(path.dirname(path.join(temp, name)), { recursive: true, mode: 0o700 });
        atomic(path.join(temp, name), fs.readFileSync(path.join(pkg, name)));
      }
      atomic(path.join(temp, 'original-hashes.json'), json(Object.fromEntries(changed.map(n => [n, state.current[n]]))));
      fs.renameSync(temp, dir);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  verifyBackup(dir, state.current);
  return dir;
}
function verifyBackup(dir, originals) {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Refusing symlink baseline');
  for (const name of changed) {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile() || sha(fs.readFileSync(file)) !== originals[name]) throw new Error('Original baseline drift');
  }
}
export function stagePackage(pkg) {
  // Sibling staging preserves npm dependency lookup. No source files are changed.
  const stage = fs.mkdtempSync(path.join(path.dirname(pkg), '.context-mode-resource-'));
  try {
    fs.cpSync(path.join(pkg, 'build'), path.join(stage, 'build'), { recursive: true });
    fs.copyFileSync(path.join(pkg, 'package.json'), path.join(stage, 'package.json'));
    fs.copyFileSync(path.join(pkg, 'server.bundle.mjs'), path.join(stage, 'server.bundle.mjs'));
    if (fs.existsSync(path.join(pkg, 'node_modules'))) fs.symlinkSync(path.join(pkg, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
    for (const [name, transform] of Object.entries(transforms)) {
      fs.writeFileSync(path.join(stage, name), transform(fs.readFileSync(path.join(pkg, name), 'utf8')));
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
export async function patch({ mode = 'check', packageDir = DEFAULT_PACKAGE, cacheDir = DEFAULT_CACHE } = {}) {
  let state = inspect(packageDir);
  if (mode === 'check') return { version: VERSION, revision: REVISION, state: state.state, files: changed.length, valid: true };
  if (!['apply', 'restore'].includes(mode)) throw new Error('Unknown mode');
  if (mode === 'apply' && state.state === 'patched' || mode === 'restore' && state.state === 'original')
    return { version: VERSION, revision: REVISION, state: state.state, unchanged: true };
  const pkg = state.pkg;
  const release = acquireLock(pkg, cacheDir);
  let stage;
  try {
    state = inspect(pkg);
    if (mode === 'apply' && state.state === 'patched' || mode === 'restore' && state.state === 'original')
      return { version: VERSION, revision: REVISION, state: state.state, unchanged: true };
    if (mode === 'apply') {
      stage = stagePackage(pkg);
      await smoke(stage);
      // Recheck before any package mutation. A failed build or smoke leaves it untouched.
      if (inspect(pkg).state !== 'original') throw new Error('Package changed while staging');
      const originals = Object.fromEntries(changed.map(n => [n, state.current[n]]));
      const files = Object.fromEntries(changed.map(n => [n, sha(fs.readFileSync(path.join(stage, n)))]));
      if (changed.some(n => files[n] !== EXPECTED_PATCHED[n])) throw new Error('Generated patch hash drift');
      const backup = ensureBackup(pkg, cacheDir, state);
      const manifest = { revision: REVISION, patchVersion: 1, version: VERSION, baseline: BASELINE, bunVersion: BUN_VERSION, originals, files };
      try {
        for (const name of changed) atomic(path.join(pkg, name), fs.readFileSync(path.join(stage, name)), fs.statSync(path.join(pkg, name)).mode & 0o777);
        atomic(path.join(pkg, MARKER), json(manifest));
      } catch (err) {
        for (const name of changed) atomic(path.join(pkg, name), fs.readFileSync(path.join(backup, name)), fs.statSync(path.join(pkg, name)).mode & 0o777);
        if (fs.existsSync(path.join(pkg, MARKER))) fs.unlinkSync(path.join(pkg, MARKER));
        throw err;
      }
    } else {
      const backup = baselineDir(cacheDir);
      verifyBackup(backup, state.manifest.originals);
      const saved = Object.fromEntries(changed.map(n => [n, fs.readFileSync(path.join(pkg, n))]));
      try {
        for (const name of changed) atomic(path.join(pkg, name), fs.readFileSync(path.join(backup, name)), fs.statSync(path.join(pkg, name)).mode & 0o777);
        fs.unlinkSync(path.join(pkg, MARKER));
      } catch (err) {
        for (const name of changed) atomic(path.join(pkg, name), saved[name], fs.statSync(path.join(pkg, name)).mode & 0o777);
        atomic(path.join(pkg, MARKER), json(state.manifest));
        throw err;
      }
    }
    return { version: VERSION, revision: REVISION, state: inspect(pkg).state, files: changed.length, smoke: mode === 'apply' ? 'passed' : undefined };
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
