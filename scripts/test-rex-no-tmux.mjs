#!/usr/bin/env node
/** Replacement can operate with tmux deliberately unavailable on fixture PATH. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 30_000 });
try {
  const host = driver.create({ command: ['/bin/sh', '-c', 'if command -v tmux >/dev/null; then exit 42; fi; echo NO_TMUX_READY; sleep 10'], env: { PATH: '/usr/bin:/bin' }, columns: 60, rows: 12 });
  const until = Date.now() + 12_000;
  let screen = '';
  while (Date.now() < until) {
    screen = driver.capture(host);
    if (screen.includes('NO_TMUX_READY')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(screen.includes('NO_TMUX_READY'), screen);
  driver.close(host);
  console.log('PASS Rex fixture operates without tmux on its PATH');
} finally { if (fs.existsSync(driver.root)) await driver.stop(); }
