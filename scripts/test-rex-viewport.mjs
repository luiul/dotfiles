#!/usr/bin/env node
/** Pin exact row boundaries, not just a marker somewhere in the frame. */
import assert from 'node:assert/strict';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 40_000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const host = driver.create({ columns: 40, rows: 6, command: ['/bin/sh', '-c', 'printf "\\033[?1049h\\033[2J\\033[HTOP_ROW\\033[6;1HBOTTOM_ROW"; sleep 25'] });
  let screen = '';
  for (let n = 0; n < 80; n++) { screen = driver.capture(host, { trim: true }); if (screen.includes('BOTTOM_ROW')) break; await pause(100); }
  const rows = screen.split('\n');
  assert.equal(rows.length, 6);
  assert.equal(rows[0], 'TOP_ROW', JSON.stringify(rows));
  assert.equal(rows[5], 'BOTTOM_ROW', JSON.stringify(rows));
  console.log('PASS exact first and last viewport rows');
} finally { await driver.stop(); }
