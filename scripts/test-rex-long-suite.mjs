#!/usr/bin/env node
/** Many exited hosts must not make verified teardown exceed its budget. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 120_000 });
let stopped = false;
try {
  for (let i = 0; i < 14; i++) {
    const host = driver.create({ command: ['/bin/sh', '-c', `echo HOST_${i}; exit 0`], columns: 80, rows: 20 });
    const end = Date.now() + 12_000;
    while (!driver.process(host).last_exit && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    assert.equal(driver.process(host).last_exit?.exit_code, 0);
    driver.close(host);
  }
  const start = performance.now();
  await driver.stop(); stopped = true;
  const milliseconds = performance.now() - start;
  assert(milliseconds < 30_000, `Verified teardown exceeded 30 seconds: ${milliseconds}`);
  assert(!fs.existsSync(driver.root));
  console.log(`PASS 14 exited hosts: verified teardown ${milliseconds.toFixed(0)}ms`);
} finally { if (!stopped && fs.existsSync(driver.root)) await driver.stop(); }
