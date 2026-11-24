#!/usr/bin/env node
/** Change only future-session Hermes entries through the current Pi settings lock. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rollingSource, legacySource, disabledNpm, prepareRolling } from './prepare-hermes-rolling.mjs';

export function resolveManagedRuntime(installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), '.pi/agent/install')) {
  const version = fs.readFileSync(join(installRoot, 'current-version'), 'utf8').trim();
  assert(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) && !['.', '..'].includes(version), 'Invalid managed Pi version');
  const runtime = join(installRoot, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(fs.readFileSync(join(runtime, 'package.json'), 'utf8')).version, version, 'Managed Pi version mismatch');
  assert(fs.existsSync(join(runtime, 'dist/core/settings-manager.js')), 'Managed Pi settings runtime missing');
  return runtime;
}
export async function activateRolling(agentDir, runtime = resolveManagedRuntime(), approved = false, centralSettings = join(homedir(), 'projects/hellofresh/.pi/settings.json')) {
  assert(approved, 'Activation requires explicit approval');
  // The shared central intake override is another owner's file. Fail closed
  // until it excludes every source we may select. Never change it here.
  const central = JSON.parse(fs.readFileSync(centralSettings, 'utf8'));
  for (const source of [disabledNpm.source, legacySource, rollingSource]) {
    assert(central.packages?.some(p => p?.source === source && Array.isArray(p.extensions) && p.extensions.length === 0), `Central intake must disable ${source}`);
  }
  const prepared = prepareRolling(agentDir, undefined, true);
  const { FileSettingsStorage } = await import(pathToFileURL(join(runtime, 'dist/core/settings-manager.js')).href);
  const storage = new FileSettingsStorage(process.cwd(), agentDir);
  storage.withLock('global', current => {
    assert(current, 'Global settings missing');
    const settings = JSON.parse(current);
    assert(Array.isArray(settings.packages), 'Package settings missing');
    const sourceOf = p => typeof p === 'string' ? p : p.source;
    const unexpectedLocal = settings.packages.find(p => /\/packages\/pi-hermes-memory\//.test(sourceOf(p) ?? '') && ![legacySource, rollingSource].includes(sourceOf(p)));
    assert(!unexpectedLocal, 'Refuse an unknown local Hermes source');
    const locals = settings.packages.filter(p => [legacySource, rollingSource].includes(sourceOf(p)));
    const npm = settings.packages.filter(p => sourceOf(p) === disabledNpm.source);
    assert.equal(npm.length, 1, 'Unexpected Hermes npm configuration');
    assert(locals.length <= 1, 'Multiple Hermes local sources');
    if (locals.length) {
      assert.equal(typeof locals[0], 'string', 'Refuse custom local Hermes filtering');
      assert.deepEqual(npm[0], disabledNpm, 'Refuse custom npm Hermes filtering');
      if (locals[0] === rollingSource) return undefined;
    } else assert.equal(npm[0], disabledNpm.source, 'Refuse custom Hermes filtering');
    const backup = join(agentDir, 'packages/pi-hermes-memory/settings-before-evidence-v2.json');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, current, { mode: 0o600, flag: 'wx' });
    if (locals.length) settings.packages[settings.packages.indexOf(legacySource)] = rollingSource;
    else settings.packages.splice(settings.packages.indexOf(disabledNpm.source), 1, disabledNpm, rollingSource);
    return JSON.stringify(settings, null, 2) + '\n';
  });
  return { prepared, futureSessionsActivated: true, originalPackageUnchanged: true, existingSessionsReloaded: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.includes('--approved'), 'Activation requires --approved');
    const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    console.log(JSON.stringify(await activateRolling(agent, resolveManagedRuntime(), true)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
