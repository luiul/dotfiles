#!/usr/bin/env node
/** Negative gates must not write or remove unrelated directories. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const unrelated = fs.mkdtempSync('/tmp/unrelated-terminal-proof-');
fs.writeFileSync(`${unrelated}/valuable`, 'preserve');
try {
  await assert.rejects(async () => { const driver = new RexTestDriver(unrelated); await driver.stop(); });
  assert.equal(fs.readFileSync(`${unrelated}/valuable`, 'utf8'), 'preserve');
  assert(!fs.existsSync(`${unrelated}/stop`));
  assert(!fs.existsSync(`${unrelated}/manifest.json`));
  await assert.rejects(() => RexTestDriver.start({ deadlineMs: 0 }));
  await assert.rejects(() => RexTestDriver.start({ deadlineMs: 60 * 60_000 }));
  console.log('PASS unrelated root refused without mutations and invalid deadlines rejected');
} finally {
  fs.unlinkSync(`${unrelated}/valuable`);
  fs.rmdirSync(unrelated);
}
