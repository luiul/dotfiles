#!/usr/bin/env node
/** Real Pi title lifecycle in private Rex, no network or desktop terminal. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { RexTestDriver } from './rex-test-driver.mjs';
import { repo, cli, version } from './fixtures/code-blocks-runtime.mjs';
assert.equal(version, '1.6.0');
const checkoutLabel = repo;
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8', timeout: 3000 }).trim();
const exactTitle = title => title.includes(`π • ${checkoutLabel} • ${branch} • `) && / • ttys\d+$/.test(title);
assert(!process.versions.bun, 'Use native Node for Rex');
const driver = await RexTestDriver.start({ deadlineMs: 60000 });
const deadline = Date.now() + 50000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host;
try {
  const home = join(driver.root, 'home'), agent = join(home, '.pi/agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', tuiMode: 'fullscreen', cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }));
  const events = join(driver.root, 'events.jsonl'), raw = join(driver.root, 'ansi.log'), probe = join(driver.root, 'probe.ts');
  writeFileSync(probe, `import {appendFileSync} from 'node:fs';
import {ProcessTerminal} from '@earendil-works/pi-tui';
export default function(pi) {
 const note=(type,data={})=>appendFileSync(process.env.TITLE_EVENTS,JSON.stringify({type,pid:process.pid,...data})+'\\n');
 const original=ProcessTerminal.prototype.setTitle;
 ProcessTerminal.prototype.setTitle=function(title){note('title',{title}); return original.call(this,title);};
 pi.registerProvider('title-fixture',{api:'title-blocked',baseUrl:'http://local.invalid',apiKey:'no-network',models:[{id:'fixture',name:'Title fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}],streamSimple(){throw new Error('Forbidden model call');}});
 pi.registerCommand('fixture-rename',{handler:async()=>pi.setSessionName('test title')});
 pi.on('session_start',e=>note('ready',{reason:e.reason})); pi.on('session_shutdown',e=>{note('shutdown',{reason:e.reason});ProcessTerminal.prototype.setTitle=original;});
}`);
  const log = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const titles = () => log().filter(e => e.type === 'title').map(e => e.title);
  const wait = async predicate => {
    while (Date.now() < deadline) {
      const screen = driver.capture(host);
      assert(!/TypeError:|Extension error|Failed to load extension/.test(screen), screen);
      if (predicate()) return;
      await pause(100);
    }
    throw new Error('Title fixture timed out: ' + JSON.stringify(log()));
  };
  host = driver.create({ name: 'session-title-fixture', command: [process.execPath, cli, '--offline', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-approve', '--no-themes', '--no-tools', '--provider', 'title-fixture', '--model', 'fixture', '-e', join(repo, 'pi/.pi/agent/extensions/session-title.ts'), '-e', probe], cwd: repo, columns: 100, rows: 30,
    env: { HOME: home, PATH: '/opt/homebrew/bin:/usr/bin:/bin', PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', PI_PROGRAM_STATUS: '0', PI_TUI_WRITE_LOG: raw, TITLE_EVENTS: events } });
  const command = text => { driver.text(host, text); driver.key(host, 'enter'); };
  await wait(() => log().some(e => e.type === 'ready') && titles().some(exactTitle));
  console.log('PASS real 1.6 title contains exact worktree path, branch and tty');
  assert(exactTitle(titles().at(-1)), JSON.stringify(titles()));
  for (const cmd of ['/fixture-rename', '/reload', '/new']) {
    const offset = titles().length, starts = log().filter(e => e.type === 'ready').length;
    command(cmd);
    await wait(() => titles().slice(offset).some(exactTitle) && (cmd === '/fixture-rename' || log().filter(e => e.type === 'ready').length > starts));
    console.log('PASS ' + cmd + ' restores exact title without stale context errors');
  }
  const pid = driver.pid(host), started = performance.now();
  driver.key(host, 'ctrl+d');
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert(performance.now() - started < 5000, 'Retry timers delayed shutdown');
  assert(log().some(e => e.type === 'shutdown' && e.reason === 'quit'));
  console.log('PASS shutdown exits without waiting for 15-second retries');
} finally {
  const result = await driver.stop();
  assert(result.clean, JSON.stringify(result));
  console.log('PASS private server and registered target cleanup');
}
