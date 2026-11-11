#!/usr/bin/env node
/** Closing before the registration handshake must not invent an unresolved PID. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 30_000 });
try {
  const marker = `${driver.root}/should-not-run`;
  const host = driver.create({ command: ['/bin/sh', '-c', `echo ran > '${marker}'; sleep 60`] });
  driver.close(host);
  // Registration may finish before closure; it is valid either way. Teardown
  // must resolve every published request and verify all started targets gone.
  await driver.stop();
  assert(!fs.existsSync(driver.root));
  console.log('PASS immediate close resolves registration and private cleanup');
} finally { if (fs.existsSync(driver.root)) await driver.stop(); }
