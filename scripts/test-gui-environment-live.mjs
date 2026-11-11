#!/usr/bin/env node
/** Real Pi TUI with a stripped GUI environment. No model requests or live stores.
 * Default: inherited fixture key. --live reads trusted local credentials only
 * when explicitly authorized. --cancel-before-ready tests owner signal cleanup.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

assert(!process.versions.bun, 'Run with Node to test the actual Node runtime');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
const cancelBeforeReady = process.argv.includes('--cancel-before-ready');
const managed = join(homedir(), '.pi/agent/install');
const runtimeVersion = readFileSync(join(managed, 'current-version'), 'utf8').trim();
const runtime = join(managed, 'releases', runtimeVersion, 'node_modules/@earendil-works/pi-coding-agent');
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
const events = join(root, 'events.jsonl'), fixture = join(root, 'fixture.ts');
const records = () => existsSync(events) ? readFileSync(events, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const pause = ms => new Promise(r => setTimeout(r, ms));
let driver, host, failure, outcome, cancelled = false, cancellationSent = false;
const cancel = () => { cancelled = true; };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
async function wait(predicate, { timeout = 20000, cancellable = true } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancellable && cancelled) throw Error('Test cancelled');
    if (predicate()) return;
    await pause(50);
  }
  throw Error('TUI deadline exceeded');
}
function gone(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid fixture process PID');
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
try {
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], cacheWarming: 'off', compaction: { enabled: false },
    retry: { enabled: false }, enableInstallTelemetry: false, defaultProjectTrust: 'never' }), { mode: 0o600 });
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'ai-model-router': {
    api: router.api, apiKey: router.apiKey, baseUrl: 'http://127.0.0.1:1/v1',
    models: router.models.filter(model => model.id === review),
  } } }), { mode: 0o600 });
  writeFileSync(fixture, `import fs from 'node:fs';
export default async function(pi) {
  ${cancelBeforeReady ? `fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'starting',pid:process.pid})+'\\n'); await new Promise(r => setTimeout(r,10000));` : ''}
  pi.on('session_start', async (_,ctx) => {
    const model = ctx.modelRegistry.find('ai-model-router', ${JSON.stringify(review)});
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    const child = await pi.exec('pi', ['--version'], {timeout:10000});
    fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'ready',pid:process.pid,mode:ctx.mode,execPath:process.execPath,
      keyPresent:Boolean(process.env.AI_MODEL_ROUTER_API_KEY),authResolved:auth.ok && Boolean(auth.apiKey),
      fixtureKeyPreserved:process.env.AI_MODEL_ROUTER_API_KEY === 'fixture-only',
      childCode:child.code,childVersion:child.stdout.trim()})+'\\n');
    pi.sendMessage({customType:'gui-check',content:'GUI_ENVIRONMENT_OK',display:true});
  });
  pi.on('session_shutdown', () => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({type:'shutdown',pid:process.pid})+'\\n'));
}`, { mode: 0o600 });
  // The shared supervisor and explicit registry own deadlines and owner-crash
  // cleanup. This harness never discovers or touches the desktop Rex server.
  driver = await RexTestDriver.start({ deadlineMs: 60000 });
  if (cancelled) throw Error('Test cancelled');
  host = driver.create({ name: 'ag-pi-gui-' + process.pid, cwd: root, columns: 110, rows: 35,
    command: [process.execPath, join(runtime, 'dist/cli.js'),
      '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-approve',
      '--model', 'ai-model-router/' + review, '-e', join(repo, 'pi/.pi/agent/extensions/gui-environment.ts'), '-e', fixture],
    env: { HOME: live ? homedir() : home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', TMPDIR: root,
      PI_CODING_AGENT_DIR: agent, PI_MANAGED_INSTALL_ROOT: managed, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
      ...(live ? {} : { AI_MODEL_ROUTER_API_KEY: 'fixture-only' }) } });
  if (cancelBeforeReady) {
    await wait(() => records().some(event => event.type === 'starting'));
    cancellationSent = true;
    process.kill(process.pid, 'SIGTERM');
    await pause(50);
  }
  await wait(() => records().some(event => event.type === 'ready'));
  const ready = records().find(event => event.type === 'ready');
  assert.equal(ready.pid, driver.pid(host));
  assert.equal(ready.execPath, process.execPath);
  assert.equal(ready.mode, 'tui'); assert(ready.keyPresent); assert(ready.authResolved);
  if (!live) assert(ready.fixtureKeyPreserved, 'Inherited fixture key was replaced');
  assert.equal(ready.childCode, 0); assert.equal(ready.childVersion, runtimeVersion);
  await wait(() => driver.capture(host).includes('GUI_ENVIRONMENT_OK'));
  driver.text(host, '/quit'); driver.key(host, 'enter');
  await wait(() => records().some(event => event.type === 'shutdown' && event.pid === ready.pid));
  await wait(() => gone(ready.pid) && driver.process(host).last_exit);
  assert.equal(driver.process(host).last_exit.exit_code, 0);
  outcome = 'real Pi TUI: ' + (live ? 'missing key recovered from trusted local sources' : 'inherited fixture key preserved')
    + ', router auth resolved, managed pi child started from stripped PATH, orderly shutdown';
} catch (error) {
  if (cancelled && cancellationSent && error.message === 'Test cancelled' && !records().some(event => event.type === 'ready')) {
    outcome = 'SIGTERM before TUI readiness reached signal cleanup';
  } else failure = error;
} finally {
  const cleanupErrors = [];
  let pid;
  try {
    // Read starting too: cancellation can happen before the ready event exists.
    const event = records().find(event => event.type === 'ready') ?? records().find(event => event.type === 'starting');
    pid = host ? driver.pid(host) : null;
    if (event) { assert.equal(event.pid, pid, 'Event PID differs from the registered exec target'); pid = event.pid; }
    if (host) assert(pid, 'Fixture target PID was not recorded');
    if (failure && host) writeFileSync(join(root, 'terminal.txt'), driver.capture(host, { history: true }), { mode: 0o600 });
  } catch (error) { cleanupErrors.push(error); }
  try {
    if (host) {
      driver.close(host);
      // Missing sessions now return a specific failure. A controller or
      // unrelated transport error must not count as proof of removal.
      assert.throws(() => driver.process(host), /session_not_found|session not found/i,
        'Owned Rex block remains after close');
      assert.throws(() => driver.api('session.view', { session_id: host.sessionId }), /session_not_found|session not found/i,
        'Owned Rex session remains after close');
    }
  } catch (error) { cleanupErrors.push(error); }
  try {
    if (driver) {
      const stopped = await driver.stop();
      assert(stopped?.clean, 'Private Rex cleanup was not verified');
      assert(!existsSync(driver.root), 'Private Rex fixture remains');
    }
    if (pid) await wait(() => gone(pid), { timeout: 5000, cancellable: false });
  } catch (error) { cleanupErrors.push(error); }
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if (failure || cleanupErrors.length) {
    // Keep events and fixture files after a test or cleanup failure. The driver
    // also retains its own evidence if server or target cleanup is unresolved.
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      `GUI test failed; retained evidence at ${root}${driver && existsSync(driver.root) ? ` and ${driver.root}` : ''}`);
  }
  rmSync(root, { recursive: true, force: true });
  assert(!existsSync(root));
  console.log('PASS ' + outcome);
  console.log('PASS registered exec target exited, owned Rex session closed, private server and supervisor stopped, temporary files removed');
}
