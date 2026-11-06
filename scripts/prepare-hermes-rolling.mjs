#!/usr/bin/env node
/** Prepare a separate Hermes copy. Never modify the package used by running sessions. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyPatch, preparePatch } from './patch-hermes-memory.mjs';

export const rollingSource = '~/.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1';
export const disabledNpm = { source: 'npm:pi-hermes-memory', extensions: [], skills: [], prompts: [], themes: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function prepareRolling(agentDir, installed = join(agentDir, 'npm/node_modules/pi-hermes-memory')) {
  const original = preparePatch(installed);
  assert.equal(original.version, '0.10.0', 'Rolling copy requires Hermes 0.10.0');
  assert(!original.alreadyApplied, 'Keep the installed baseline unchanged for running agents');
  const parent = join(agentDir, 'packages/pi-hermes-memory');
  for (let p = parent; p !== dirname(p); p = dirname(p)) if (existsSync(p)) assert(!lstatSync(p).isSymbolicLink(), `Unsafe rollout directory: ${p}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const destination = join(parent, '0.10.0-evidence-v1');
  const verify = directory => {
    assert(preparePatch(directory).alreadyApplied, 'Prepared copy is not patched');
    const manifest = JSON.parse(readFileSync(join(directory, '.rolling-package.json'), 'utf8'));
    for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(join(directory, file))), digest, `Rolling source drift: ${file}`);
  };
  if (existsSync(destination)) { assert(!lstatSync(destination).isSymbolicLink()); verify(destination); return destination; }
  const temp = mkdtempSync(join(parent, '.prepare-'));
  try {
    cpSync(installed, temp, { recursive: true, filter: p => !p.slice(installed.length).includes('/node_modules') });
    // Copy each immutable runtime dependency. No live stores or credentials are linked.
    const require = createRequire(join(installed, 'package.json'));
    for (const name of ['better-sqlite3', 'node-addon-api', 'bindings', 'file-uri-to-path', 'strip-ansi', 'ansi-regex']) {
      const resolveDependency = name === 'node-addon-api'
        ? createRequire(require.resolve('better-sqlite3')) : require;
      let dir = dirname(resolveDependency.resolve(name));
      while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
      cpSync(realpathSync(dir), join(temp, 'node_modules', name), { recursive: true });
    }
    applyPatch(temp, true);
    const files = {};
    const walk = (dir, prefix = '') => {
      // Pin runtime package code as well as the patch targets, not dependencies or backups.
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), relative + '/');
        else if (entry.isFile()) files['src/' + relative] = hash(readFileSync(join(dir, entry.name)));
        else throw Error('Unexpected source symlink');
      }
    };
    walk(join(temp, 'src'));
    files['package.json'] = hash(readFileSync(join(temp, 'package.json')));
    writeFileSync(join(temp, '.rolling-package.json'), JSON.stringify({ version: '0.10.0', files }, null, 2) + '\n', { mode: 0o600 });
    verify(temp);
    for (const item of original.updates) {
      if (item.old === null) assert(!existsSync(item.path), 'Installed helper appeared during preparation');
      else assert.equal(hash(readFileSync(item.path)), hash(item.old), 'Installed package changed during preparation');
    }
    renameSync(temp, destination);
    return destination;
  } finally { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--approved')) throw Error('Preparation requires --approved');
    const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    console.log(JSON.stringify({ prepared: prepareRolling(agent), originalPackageUnchanged: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
