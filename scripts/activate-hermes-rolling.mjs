#!/usr/bin/env node
/** Change only future-session package selection, using Pi's settings lock. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rollingSource, disabledNpm, prepareRolling } from './prepare-hermes-rolling.mjs';

export async function activateRolling(agentDir, runtime) {
  const prepared = prepareRolling(agentDir);
  const { FileSettingsStorage } = await import(pathToFileURL(join(runtime, 'dist/core/settings-manager.js')).href);
  const storage = new FileSettingsStorage(process.cwd(), agentDir);
  const backupDir = join(agentDir, 'packages/pi-hermes-memory');
  storage.withLock('global', current => {
    assert(current, 'Global settings missing');
    const settings = JSON.parse(current);
    assert(Array.isArray(settings.packages), 'Package settings missing');
    if (settings.packages.includes(rollingSource)) {
      assert.deepEqual(settings.packages.find(p=>typeof p==='object'&&p.source==='npm:pi-hermes-memory'),disabledNpm);
      return undefined;
    }
    assert.equal(settings.packages.filter(p => (typeof p==='string'?p:p.source)==='npm:pi-hermes-memory').length, 1, 'Unexpected Hermes configuration');
    const index = settings.packages.indexOf('npm:pi-hermes-memory');
    assert(index >= 0, 'Refuse to overwrite custom Hermes filtering');
    const backup = join(backupDir, 'settings-before-rolling.json');
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, current, { mode: 0o600, flag: 'wx' });
    settings.packages.splice(index, 1, disabledNpm, rollingSource);
    return JSON.stringify(settings, null, 2) + '\n';
  });
  return { prepared, futureSessionsActivated: true, originalPackageUnchanged: true, existingSessionsReloaded: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.includes('--approved'), 'Activation requires --approved');
    const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    const runtime = join(homedir(), '.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
    console.log(JSON.stringify(await activateRolling(agent, runtime)));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
