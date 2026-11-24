#!/usr/bin/env node
/** Prepare immutable code for future sessions. Never edit the selected source. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyPatch, preparePatch, revision, legacyRevision } from './patch-hermes-memory.mjs';

export const rollingName = '0.10.0-evidence-v2';
export const rollingSource = `~/.pi/agent/packages/pi-hermes-memory/${rollingName}`;
export const legacySource = '~/.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1';
export const disabledNpm = { source: 'npm:pi-hermes-memory', extensions: [], skills: [], prompts: [], themes: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function sourceFiles(directory) {
  const files = {};
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative + '/');
      else if (entry.isFile()) files[relative] = hash(readFileSync(join(dir, entry.name)));
      else throw Error('Unexpected source symlink');
    }
  };
  walk(join(directory, 'src'), 'src/');
  files['package.json'] = hash(readFileSync(join(directory, 'package.json')));
  return files;
}
export function verifyRolling(directory) {
  const plan = preparePatch(directory);
  assert(plan.alreadyApplied, 'Prepared copy is not patched');
  const manifest = JSON.parse(readFileSync(join(directory, '.rolling-package.json'), 'utf8'));
  assert.equal(manifest.version, '0.10.0');
  if (plan.revision === revision) assert.equal(manifest.revision, revision);
  assert.deepEqual(sourceFiles(directory), manifest.files, 'Rolling source drift');
  return plan;
}
export function prepareRolling(agentDir, installed = join(agentDir, 'npm/node_modules/pi-hermes-memory'), approved = false) {
  const parent = join(agentDir, 'packages/pi-hermes-memory');
  for (let p = parent; p !== dirname(p); p = dirname(p)) if (existsSync(p)) assert(!lstatSync(p).isSymbolicLink(), `Unsafe rollout directory: ${p}`);
  const destination = join(parent, rollingName);
  // A verified immutable destination remains usable after npm upgrades.
  if (existsSync(destination)) {
    assert(!lstatSync(destination).isSymbolicLink());
    assert.equal(verifyRolling(destination).revision, revision);
    return destination;
  }
  assert(approved, 'Preparation requires explicit approval');
  const legacy = join(parent, '0.10.0-evidence-v1');
  const source = existsSync(legacy) ? legacy : installed;
  const original = preparePatch(source);
  assert.equal(original.version, '0.10.0', 'Rolling copy requires Hermes 0.10.0');
  if (source === legacy) assert.equal(verifyRolling(source).revision, legacyRevision);
  else assert(!original.alreadyApplied, 'Keep installed source unchanged');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(parent, '.prepare-'));
  try {
    cpSync(source, temp, { recursive: true, filter: p => !p.slice(source.length).includes('/node_modules') });
    if (source === legacy) {
      // Restore only reviewed baseline code inside our unpublished private copy.
      for (const file of Object.keys(original.baseline)) cpSync(join(source, '.pi-memory-hardening-baseline', file), join(temp, file));
      rmSync(join(temp, 'src/tools/search-scope.ts'));
      rmSync(join(temp, '.pi-memory-hardening.json'));
      rmSync(join(temp, '.rolling-package.json'));
      rmSync(join(temp, '.pi-memory-hardening-baseline'), { recursive: true });
    }
    const require = createRequire(join(source, 'package.json'));
    for (const name of ['better-sqlite3', 'node-addon-api', 'bindings', 'file-uri-to-path', 'strip-ansi', 'ansi-regex']) {
      const resolver = name === 'node-addon-api' ? createRequire(require.resolve('better-sqlite3')) : require;
      let dir = dirname(resolver.resolve(name));
      while (!existsSync(join(dir, 'package.json'))) { const next = dirname(dir); assert.notEqual(next, dir); dir = next; }
      cpSync(realpathSync(dir), join(temp, 'node_modules', name), { recursive: true });
    }
    applyPatch(temp, true);
    writeFileSync(join(temp, '.rolling-package.json'), JSON.stringify({ version: '0.10.0', revision, files: sourceFiles(temp) }, null, 2) + '\n', { mode: 0o600 });
    verifyRolling(temp);
    for (const item of original.updates) {
      if (item.old === null) assert(!existsSync(item.path), 'Source helper appeared');
      else assert.equal(hash(readFileSync(item.path)), hash(item.old), 'Source changed during preparation');
    }
    if (source === legacy) verifyRolling(source);
    assert(!existsSync(destination), 'Concurrent immutable destination appeared');
    renameSync(temp, destination);
    return destination;
  } finally { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.includes('--approved'), 'Preparation requires --approved');
    const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    console.log(JSON.stringify({ prepared: prepareRolling(agent, undefined, true), originalPackageUnchanged: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
