#!/usr/bin/env node
/** Real Pi TUI with a stripped GUI environment. No live stores or model requests. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const runtime = join(homedir(), '.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
const managed = join(homedir(), '.pi/agent/install');
const router = JSON.parse(readFileSync(join(repo, 'pi/.pi/agent/models.json'), 'utf8')).providers['ai-model-router'];
const review = JSON.parse(readFileSync(join(repo, 'pi/.pi/agent/hermes-memory-config.json'), 'utf8')).llmModelOverride.split('/').slice(1).join('/');
assert.equal(router.apiKey, '$AI_MODEL_ROUTER_API_KEY');
if (live) {
  assert.equal(process.platform, 'darwin');
  const lookup = spawnSync('/bin/launchctl', ['getenv', 'AI_MODEL_ROUTER_API_KEY'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(lookup.status, 0);
  assert(lookup.stdout.trim(), 'GUI key missing. Run gui-env-sync before this live check.');
}
const root = mkdtempSync(join(tmpdir(), 'pi-gui-live-'));
const home = join(root, 'home'), agent = join(home, '.pi/agent');
const name = 'ag-pi-gui-' + process.pid;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const run = (cmd, args) => execFileSync(cmd, cmd === 'tmux' ? ['-L', name, ...args] : args,
  { encoding: 'utf8', timeout: 15000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
let made = false, cancelled = false;
const cancel = () => { cancelled = true; };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
// Independent guard covers parent death and this private tmux server's deadline.
const guard = spawn(process.execPath, ['--input-type=module', '-e', `
import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
const stop = () => {
  const panes = spawnSync('tmux', ['-L', ${JSON.stringify(name)}, 'list-panes', '-a', '-F', '#{pane_pid}'], {encoding:'utf8',timeout:5000});
  for (const pid of (panes.stdout ?? '').trim().split('\\n').map(Number)) {
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid,'SIGKILL'); } catch {} }
  }
  spawnSync('tmux', ['-L', ${JSON.stringify(name)}, 'kill-server'], {stdio:'ignore',timeout:5000});
  rmSync(${JSON.stringify(root)}, {recursive:true,force:true});
  process.exit(0);
};
process.on('disconnect',stop); process.on('message',stop);
setTimeout(stop,60000);
`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const guardExit = once(guard, 'exit');
try {
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], cacheWarming: 'off', compaction: { enabled: false },
    retry: { enabled: false }, enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'ai-model-router': {
    api: router.api, apiKey: router.apiKey, baseUrl: 'http://127.0.0.1:1/v1',
    models: router.models.filter(model => model.id === review),
  } } }));
  const events = join(root, 'events.jsonl'), fixture = join(root, 'fixture.ts');
  writeFileSync(fixture, `import fs from 'node:fs';
export default async function(pi) {
  ${process.argv.includes('--cancel-before-ready') ? `fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'starting',pid:process.pid})+'\\n'); await new Promise(r => setTimeout(r,10000));` : ''}
  pi.on('session_start', async (_,ctx) => {
    const model = ctx.modelRegistry.find('ai-model-router', ${JSON.stringify(review)});
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    const child = await pi.exec('pi', ['--version'], {timeout:10000});
    fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'ready',pid:process.pid,mode:ctx.mode,
      keyPresent:Boolean(process.env.AI_MODEL_ROUTER_API_KEY),authResolved:auth.ok && Boolean(auth.apiKey),
      childCode:child.code,childVersion:child.stdout.trim()})+'\\n');
    pi.sendMessage({customType:'gui-check',content:'GUI_ENVIRONMENT_OK',display:true});
  });
  pi.on('session_shutdown', () => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'shutdown'})+'\\n'));
}`);
  const command = ['env', '-i', `HOME=${live ? homedir() : home}`, 'PATH=/usr/bin:/bin', 'TERM=xterm-256color', `TMPDIR=${root}`,
    `PI_CODING_AGENT_DIR=${agent}`, `PI_MANAGED_INSTALL_ROOT=${managed}`, 'PI_OFFLINE=1', 'PI_SKIP_VERSION_CHECK=1',
    ...(live ? [] : ['AI_MODEL_ROUTER_API_KEY=fixture-only']), process.execPath, join(runtime, 'dist/cli.js'),
    '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-approve',
    '--model', 'ai-model-router/' + review, '-e', join(repo, 'pi/.pi/agent/extensions/gui-environment.ts'), '-e', fixture].map(quote).join(' ');
  execFileSync('tmux', ['-L', name, 'new-session', '-d', '-s', name, '-x', '110', '-y', '35', '-c', root, command],
    { stdio: 'ignore', timeout: 15000 });
  made = true;
  const reaper = await import(pathToFileURL(join(repo, 'macos/.local/bin/reap-strays.mjs')).href);
  const ps = reaper.createPs();
  const tmux = reaper.createTmux(ps, undefined, (bin, args, env) => spawnSync(bin, ['-L', name, ...args.slice(2)],
    { env, encoding: 'utf8', timeout: 5000 }));
  reaper.registerTmux({ name, pid: process.pid, deadline: Math.floor(Date.now()/1000) + 60 },
    { ps, tmux, config: { ...reaper.configuration(), directory: join(root, 'reaper') }, write: () => {} });
  const records = () => existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const wait = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (cancelled) throw Error('Test cancelled');
      if (predicate()) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('TUI deadline exceeded');
  };
  if (process.argv.includes('--cancel-before-ready')) {
    await wait(() => records().some(event => event.type === 'starting'));
    process.kill(process.pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 50));
  }
  await wait(() => records().some(event => event.type === 'ready'));
  const ready = records().find(event => event.type === 'ready');
  assert.equal(ready.mode, 'tui'); assert(ready.keyPresent); assert(ready.authResolved);
  assert.equal(ready.childCode, 0); assert.equal(ready.childVersion, '1.5.0');
  await wait(() => run('tmux', ['capture-pane', '-t', name, '-p']).includes('GUI_ENVIRONMENT_OK'));
  run('tmux', ['send-keys', '-t', name, 'C-d']);
  await wait(() => records().some(event => event.type === 'shutdown'));
  await wait(() => { try { process.kill(ready.pid, 0); return false; } catch { return true; } });
  console.log('PASS real Pi TUI: ' + (live ? 'missing key recovered from trusted local sources' : 'inherited fixture key preserved')
    + ', router auth resolved, managed pi child started from stripped PATH, orderly shutdown');
} catch (error) {
  if (!cancelled || !process.argv.includes('--cancel-before-ready')) throw error;
  console.log('PASS SIGTERM before TUI readiness reached signal cleanup');
} finally {
  const probe = spawnSync('tmux', ['-L', name, 'list-panes', '-a', '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 5000 });
  const pids = (probe.stdout ?? '').trim().split('\n').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1);
  if (made) { try { run('tmux', ['kill-session', '-t', name]); } catch {} }
  try { run('tmux', ['has-session', '-t', name]); throw Error('Owned session remains'); }
  catch (error) { if (!String(error.message).includes('Command failed')) throw error; }
  try { run('tmux', ['kill-server']); } catch {}
  for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  const deadline = Date.now() + 5000;
  for (const pid of pids) {
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.throws(() => process.kill(pid, 0), 'Owned pane process remains');
  }
  if (guard.connected) guard.send('stop');
  await guardExit;
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  rmSync(root, { recursive: true, force: true });
  assert(!existsSync(root));
  console.log('PASS independent guard, owned pane processes, private server and temporary files removed');
}
