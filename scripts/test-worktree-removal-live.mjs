#!/usr/bin/env node
// Real Pi TUI fixture with the candidate extension set. No remote model calls.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The managed launcher selects releases via current-version. The legacy
// current symlink can still name a removed release; never update it here.
const install = join(homedir(), '.pi/agent/install');
const version = readFileSync(join(install, 'current-version'), 'utf8').trim();
assert(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version), 'Invalid managed Pi version');
const cli = join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
assert(existsSync(cli), `Managed Pi CLI missing: ${cli}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-removal-live-')));
const events = join(root, 'events.jsonl');
const home = join(root, 'home');
const config = join(home, '.pi/agent');
mkdirSync(join(config, 'extensions'), { recursive: true });
const log = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let driver, host, pid, failure;

try {
  const sourceExtensions = process.env.WORKTREE_REMOVAL_EXTENSIONS ?? join(repo, 'pi/.pi/agent/extensions');
  for (const file of readdirSync(sourceExtensions)) {
    const source = join(sourceExtensions, file);
    if ((lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) && /\.(ts|js)$/.test(file)) {
      symlinkSync(source, join(config, 'extensions', file));
    }
  }
  // Only fixture settings are read. No user packages, models or credentials.
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
  // The supervisor owns this private server and target before Pi can execute.
  // The parent registry backstop is still a deployment gate, not a tmux hook.
  driver = await RexTestDriver.start({ deadlineMs: 90_000 });
  host = driver.create({
    name: `ag-guard-removal-${process.pid}`,
    command: [process.execPath, cli, '--offline', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--session-dir', join(root, 'sessions'), '-e', join(repo, 'scripts/fixtures/worktree-removal-live.ts')],
    cwd: repo,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: root,
      PI_CODING_AGENT_DIR: config,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      PI_OFFLINE: '1',
      WORKTREE_REMOVAL_EVENTS: events,
      // Prevent gui-environment from reading launchd's real router credential.
      AI_MODEL_ROUTER_API_KEY: 'offline-fixture-not-a-credential',
    },
    columns: 120,
    rows: 35,
  });
  const until = Date.now() + 70_000;
  const waitEvent = async (event, message) => {
    while (!log().some(e => e.event === event)) {
      if (Date.now() > until) throw Error(`${message}\n${driver.capture(host)}`);
      await sleep(200);
    }
  };
  await waitEvent('start', 'Pi startup timed out');
  const initial = log().find(e => e.event === 'start');
  pid = initial.pid; // The fixture event names Pi, not Rex's outer login process.
  assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid Pi fixture PID');
  assert.equal(pid, driver.pid(host), 'Pi event PID must match the supervised exec target');
  assert(!initial.commands.includes('work-status'));
  driver.text(host, '/removal-check');
  driver.key(host, 'enter');
  await waitEvent('checked', 'Pi command timed out');
  // The event can arrive before the terminal redraw reaches Rex.
  let screen;
  do {
    screen = driver.capture(host);
    if (screen.includes('GUARD_REMOVAL_VERIFIED') || Date.now() > until) break;
    await sleep(200);
  } while (true);
  assert(screen.includes('GUARD_REMOVAL_VERIFIED'), screen);
  assert(!/Work pending|Work status unavailable|\/work-status|Failed to load extension|Extension error/.test(screen), screen);
  console.log('PASS: real Pi loads candidate extensions without completion command or widget');
  driver.key(host, 'ctrl+u');
  driver.key(host, 'ctrl+d');
  await waitEvent('shutdown', 'Pi shutdown timed out');
  console.log('PASS: fresh interactive session starts, accepts a command, and shuts down');
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  // Close the PTY first. stop() then verifies the owned server and registered
  // exec targets are gone. Keep evidence if supervisor cleanup is unresolved.
  if (host) {
    try {
      pid ??= log().find(e => e.event === 'start')?.pid ?? driver.pid(host);
    } catch (error) { cleanupErrors.push(error); }
    try { driver.close(host); } catch (error) { cleanupErrors.push(error); }
  }
  let stopped = !driver;
  if (driver) {
    try { await driver.stop(); stopped = true; } catch (error) { cleanupErrors.push(error); }
  }
  if (pid) {
    try {
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', `Pi fixture PID ${pid} survived cleanup`);
      console.log('PASS: closed session, stopped private Rex driver, and verified Pi target gone');
    } catch (error) { cleanupErrors.push(error); }
  }
  if (stopped) rmSync(root, { recursive: true, force: true });
  else console.error(`Cleanup evidence retained: ${root}`);
  if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Worktree removal fixture failed or cleanup is unresolved');
}
if (failure) throw failure;
