/** Private fixtures from the active reviewed v1, never from newer inactive npm. */
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { preparePatch, applyPatch } from './patch-hermes-memory.mjs';
export const activeHermes = join(homedir(), '.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1');
export function copyHermesBaseline(destination, dependencies = false) {
  const source = preparePatch(activeHermes);
  fs.cpSync(activeHermes, destination, { recursive: true, filter: p => dependencies || !p.slice(activeHermes.length).includes('/node_modules') });
  for (const file of Object.keys(source.baseline)) fs.cpSync(join(activeHermes, '.pi-memory-hardening-baseline', file), join(destination, file));
  fs.rmSync(join(destination, 'src/tools/search-scope.ts'));
  fs.rmSync(join(destination, '.pi-memory-hardening.json'));
  fs.rmSync(join(destination, '.rolling-package.json'));
  fs.rmSync(join(destination, '.pi-memory-hardening-baseline'), { recursive: true });
  return destination;
}
export function copyHermesCandidate(destination) {
  copyHermesBaseline(destination, true);
  applyPatch(destination, true);
  return destination;
}
