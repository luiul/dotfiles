#!/usr/bin/env node
/** A second supervisor may not overwrite a live fixture's ownership. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 30_000 });
try {
  const before = fs.readFileSync(`${driver.root}/manifest.json`, 'utf8');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./rex-test-driver.mjs', import.meta.url)), 'supervise', driver.root], { encoding: 'utf8', timeout: 8000 });
  assert.notEqual(result.status, 0, 'Duplicate supervisor succeeded');
  assert(/EEXIST|already has a supervisor/.test(result.stderr), result.stderr);
  assert.equal(fs.readFileSync(`${driver.root}/manifest.json`, 'utf8'), before);
  driver.manifest();
  console.log('PASS duplicate supervisor refused without ownership mutation');
} finally { await driver.stop(); }
