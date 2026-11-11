#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

const config = fileURLToPath(new URL('../rex/.config/rex/init.lua', import.meta.url));
const driver = await RexTestDriver.start({ deadlineMs: 60_000 });
try {
  const manifest = driver.manifest();
  const lua = `
    local action, binding, process, modes, queued
    rex.action = function(value) action = value end
    rex.bind = function(key, name) binding = {key, name} end
    rex.block.call = function(_, method)
      if method == "process" then return process end
      if method == "modes" then return modes end
    end
    rex.client.queue = function(name, args) queued = {name, args} end
    dofile(${JSON.stringify(config)})
    assert(binding[1] == "cmd+c" and binding[2] == "copy_selection")
    local function check(name, p, m, expected, key)
      process, modes, queued = p, m, nil
      action.run({})
      assert(queued and queued[1] == expected, name)
      assert((queued[2] and queued[2].key or nil) == key, name .. " key")
    end
    local alt_mouse = {screen="alternate", modes={{name="mouse_format_sgr", set=true}}}
    local pi = {foreground={argv0="pi"}}
    check("fullscreen pi", pi, alt_mouse, "pane.send_key", "ctrl+x")
    check("pi with path", {foreground={argv0="/bin/pi"}}, alt_mouse, "pane.send_key", "ctrl+x")
    check("regular pi", pi, {screen="primary", modes=alt_mouse.modes}, "pane.copy")
    check("pi without mouse", pi, {screen="alternate", modes={{name="mouse_format_sgr", set=false}}}, "pane.copy")
    check("other fullscreen program", {foreground={argv0="vim"}}, alt_mouse, "pane.copy")
    check("unknown process", {}, alt_mouse, "pane.copy")
    check("unavailable terminal state", nil, nil, "pane.copy")
    return "PASS Rex copy routing"
  `;
  const result = execFileSync(manifest.binary, ['--autostart=false', '--timeout', '4s', '-S', manifest.endpoint, 'do', '-e', lua], { encoding: 'utf8', timeout: 10_000 });
  assert.match(result, /PASS Rex copy routing/);
  console.log(result.trim());

  // Exercise the real server action and process inspection on an isolated pane.
  fs.copyFileSync(config, path.join(driver.root, 'init.lua'));
  const reload = driver.api('server.config_reload', {});
  assert.equal(Object.keys(reload.diagnostics ?? {}).length, 0, 'Rex config reload reported diagnostics');
  const host = driver.create({
    command: [process.execPath, '-e', 'process.title="pi"; process.stdout.write("\\x1b[?1049h\\x1b[?1006hREADY"); setTimeout(()=>{},30000)'],
    cwd: driver.root,
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (driver.capture(host).includes('READY') && driver.process(host).foreground?.argv0 === 'pi') {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Fake Pi process did not become ready');
  const action = driver.api('client.action', { action: 'copy_selection', session_id: host.sessionId, block_id: host.blockId });
  assert.deepEqual(action.client_actions, [{ action: 'pane.send_key', args: { key: 'ctrl+x' } }]);
  driver.close(host);
  console.log('PASS isolated Rex server selects Pi copy action');

  // Use the real Pi TUI and a process-local clipboard, not the desktop pasteboard.
  const area = path.join(driver.root, 'pi-copy');
  const agent = path.join(area, 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, tuiMode: 'fullscreen', fullscreenCopyOnSelect: false, enableAnalytics: false, enableInstallTelemetry: false }));
  const version = fs.readFileSync(path.join(os.homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
  const cli = path.join(os.homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const events = path.join(area, 'events.jsonl');
  const preload = fileURLToPath(new URL('./fixtures/status-bar-clipboard.cjs', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/code-blocks-live.ts', import.meta.url));
  const timestamp = new Date().toISOString();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const seed = path.join(area, 'seed.jsonl');
  fs.writeFileSync(seed, [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: area },
    { type: 'model_change', id: 'model001', parentId: null, timestamp, provider: 'codeblocks-fixture', modelId: 'fixture' },
    { type: 'message', id: 'reply001', parentId: 'model001', timestamp, message: { role: 'assistant', api: 'codeblocks-fixture-stream', provider: 'codeblocks-fixture', model: 'fixture', content: [{ type: 'text', text: 'COPY_TARGET' }], usage, stopReason: 'stop', timestamp: Date.now() } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const piHost = driver.create({
    command: [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '--provider', 'codeblocks-fixture', '--model', 'fixture', '--thinking', 'off', '--session', seed, '-e', fixture],
    cwd: area, columns: 96, rows: 30,
    env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', PI_PROGRAM_STATUS: '0', SB_LIVE_EVENTS: events, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
  });
  let frame = '';
  for (let n = 0; n < 150; n++) {
    frame = driver.capture(piHost);
    if (frame.includes('COPY_TARGET') && fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('"type":"ready"')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const lines = frame.split('\n');
  const row = lines.findIndex(line => line.includes('COPY_TARGET'));
  assert(row >= 0, `Pi fixture did not render: ${frame}`);
  const col = lines[row].indexOf('COPY_TARGET') + 1;
  driver.text(piHost, `\x1b[<0;${col};${row + 1}M\x1b[<32;${col + 10};${row + 1}M\x1b[<0;${col + 10};${row + 1}m`);
  driver.key(piHost, 'ctrl+x');
  let copied;
  for (let n = 0; n < 80; n++) {
    const records = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    copied = records.find(record => record.type === 'clipboard');
    if (copied) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(copied?.text, 'COPY_TARGET', 'Pi did not copy the selected text');
  driver.close(piHost);
  console.log('PASS real Pi selection and Ctrl+X copy with isolated clipboard');
} finally {
  await driver.stop();
}
