#!/usr/bin/env node
/** A missing target is not an unrelated controller failure or empty success. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 30_000 });
try {
  const host = driver.create({ command: ['/bin/sh', '-c', 'echo READY; sleep 30'] });
  driver.close(host);
  assert.throws(() => driver.capture(host), /session_not_found|session not found/i);
  console.log('PASS missing session returns its specific failure, not empty success');
} finally { if (fs.existsSync(driver.root)) await driver.stop(); }
