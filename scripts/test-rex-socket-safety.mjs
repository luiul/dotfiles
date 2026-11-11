#!/usr/bin/env node
/** Replacing a socket must prevent any private-server operation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 35_000 });
const socket = `${driver.root}/server.sock`, parked = `${driver.root}/parked.sock`;
try {
  fs.renameSync(socket, parked);
  fs.writeFileSync(socket, 'unrelated sentinel', { mode: 0o600 });
  assert.throws(() => driver.manifest(), /socket was replaced/);
  assert.equal(fs.readFileSync(socket, 'utf8'), 'unrelated sentinel');
  fs.unlinkSync(socket);
  fs.renameSync(parked, socket);
  driver.manifest();
  console.log('PASS replaced socket refused without modifying the sentinel');
} finally {
  if (fs.existsSync(parked)) {
    if (fs.existsSync(socket) && fs.lstatSync(socket).isFile()) fs.unlinkSync(socket);
    fs.renameSync(parked, socket);
  }
  await driver.stop();
}
