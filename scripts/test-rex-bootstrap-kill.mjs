#!/usr/bin/env node
/** Pure units by default. --live runs one bounded, private bootstrap kill gate. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupOwned, verifyStartupHandoff } from './rex-startup-guard.mjs';
import { RexTestDriver, processSnapshot } from './rex-test-driver.mjs';
const driverModule = fileURLToPath(new URL('./rex-test-driver.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function units() {
  let now = 0;
  const calls = [];
  const child = (pid, resistant = false) => ({ pid, exitCode: null, signalCode: null,
    kill(signal) { calls.push([pid, signal]); if (!resistant || signal === 'SIGKILL') this.signalCode = signal; return true; } });
  const children = new Map([['server', child(100)], ['controller', child(101, true)]]);
  const report = await cleanupOwned(children, { termMs: 100, killMs: 100, sleep: async ms => { now += ms; }, now: () => now });
  assert.deepEqual(calls, [[100, 'SIGTERM'], [101, 'SIGTERM'], [101, 'SIGKILL']]);
  assert.deepEqual(report.survivors, []);
  assert(now <= 200);
  const stuck = child(102); stuck.kill = () => false;
  const unresolved = await cleanupOwned(new Map([['server', stuck]]), { termMs: 100, killMs: 100, sleep: async ms => { now += ms; }, now: () => now });
  assert.deepEqual(unresolved.survivors, [{ role: 'server', pid: 102 }]);
  const owned = new Map([['server', child(100)], ['controller', child(101)]]);
  const manifest = { serverPid: 100, controllerPid: 101, serverIdentity: '501 pinned-start', controllerIdentity: '501 pinned-start', endpoint: 'private' };
  const record = { version: 1, uid: 501, rootIdentity: { dev: 1, ino: 2 }, manifest: { ...manifest } };
  verifyStartupHandoff(manifest, record, owned, record.rootIdentity, 501);
  for (const key of Object.keys(manifest)) {
    assert.throws(() => verifyStartupHandoff({ ...manifest, [key]: 'changed' }, record, owned, record.rootIdentity, 501));
  }
  assert.throws(() => verifyStartupHandoff(manifest, record, new Map([['server', owned.get('server')]]), record.rootIdentity, 501));
  assert.throws(() => verifyStartupHandoff(manifest, record, owned, { dev: 1, ino: 3 }, 501));
  const source = fs.readFileSync(driverModule, 'utf8');
  assert(source.includes('local value,err=rex.call(method,args)'));
  assert.equal((source.match(/rex\.call\(/g) || []).length, 1, 'All broker calls must preserve nil,error');
  assert(source.includes("Object.hasOwn(result, 'result')"), 'Undefined broker results must be rejected');
  console.log('PASS units: direct ownership, TERM/KILL escalation, bounded unresolved cleanup, immutable handoff, checked broker calls');
}

async function live() {
  // No normal-server writes. Keep its instance and exact session list unchanged.
  const normal = args => {
    const result = spawnSync('rex', ['--autostart=false', '--timeout', '2s', ...args], { encoding: 'utf8', timeout: 4000 });
    assert(!result.error && result.status === 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const baseline = JSON.parse(normal(['whoami', '--json']));
  const sessions = normal(['ls', '--json']);
  const end = Date.now() + 85_000;
  const wait = async (predicate, label, limit = 12_000) => {
    const until = Math.min(end, Date.now() + limit);
    while (Date.now() < until) { if (predicate()) return; await pause(50); }
    throw new Error(`Timed out: ${label}`);
  };
  const remaining = new Set();
  try {
    for (const stage of ['before-socket', 'after-server', 'after-controller', 'pre-registration']) {
      const root = fs.realpathSync(fs.mkdtempSync('/tmp/ag-rex-tests-'));
      fs.chmodSync(root, 0o700);
      remaining.add(root);
      const owner = processSnapshot().get(process.pid);
      const binary = spawnSync('/usr/bin/which', ['rex'], { encoding: 'utf8', timeout: 3000 }).stdout.trim();
      assert(binary);
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ root, binary, endpoint: `unix://${root}/server.sock`,
        ownerPid: process.pid, ownerIdentity: owner, deadline: Math.min(end, Date.now() + 25_000), bootstrapKillStage: stage }), { mode: 0o600 });
      const supervisor = spawn(process.execPath, [driverModule, 'supervise', root], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      supervisor.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
      try {
        await wait(() => fs.existsSync(path.join(root, 'startup-stopped.json')), `${stage} guard report ${stderr}`);
        const report = JSON.parse(fs.readFileSync(path.join(root, 'startup-stopped.json'), 'utf8'));
        assert.equal(report.reason, 'supervisor-eof');
        assert.equal(report.root, root);
        assert(report.clean && report.socketAbsent, JSON.stringify(report));
        assert.deepEqual(report.survivors, []);
        assert(!fs.existsSync(path.join(root, 'server.sock')));
        assert(!fs.existsSync(path.join(root, 'ready')));
        assert(!JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).registration);
        const expected = stage === 'before-socket' ? [] : stage === 'after-server' ? ['server'] : ['server', 'controller'];
        assert.deepEqual(report.owned.map(child => child.role), expected);
        await wait(() => supervisor.exitCode !== null || supervisor.signalCode !== null, `${stage} supervisor exit`);
        await wait(() => !processSnapshot().has(report.guardPid), `${stage} guard exit`);
        const snapshot = processSnapshot();
        for (const child of report.owned) assert(!snapshot.has(child.pid), `Owned ${child.role} ${child.pid} survived`);
        assert.equal(supervisor.signalCode, 'SIGKILL');
        assert.equal(normal(['ls', '--json']), sessions);
        assert.equal(JSON.parse(normal(['whoami', '--json'])).instance_id, baseline.instance_id);
        fs.rmSync(root, { recursive: true }); remaining.delete(root);
        console.log(`PASS live ${stage}: owned children gone, guard exited, socket absent, normal server unchanged`);
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          // This ChildProcess is ours. EOF gives its guard bounded cleanup.
          supervisor.kill('SIGKILL');
          await wait(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 'owned supervisor fallback exit', 3000);
        }
      }
    }
    // Verify the success handoff and strict broker error in the same live gate.
    const driver = await RexTestDriver.start({ deadlineMs: Math.min(25_000, end - Date.now()) });
    remaining.add(driver.root);
    try {
      const manifest = driver.manifest();
      assert(fs.existsSync(path.join(driver.root, 'startup-handoff.json')));
      assert(!processSnapshot().has(manifest.startupGuardPid));
      assert.equal(driver.api('server.status', {}).pid, manifest.serverPid);
      const host = driver.create({ command: ['/bin/sh', '-c', 'echo READY; sleep 20'] });
      driver.close(host);
      assert.throws(() => driver.capture(host), /session_not_found|session not found/i);
    } finally {
      await driver.stop();
      assert(!fs.existsSync(driver.root)); remaining.delete(driver.root);
    }
    assert.equal(normal(['ls', '--json']), sessions);
    assert.equal(JSON.parse(normal(['whoami', '--json'])).instance_id, baseline.instance_id);
    console.log('PASS live registered handoff, explicit session_not_found, natural root cleanup');
  } finally {
    if (remaining.size) console.error(`Retained unresolved fixture roots: ${[...remaining].join(', ')}`);
  }
}
await units();
if (process.argv.includes('--live')) await live();
else assert.equal(process.argv.length, 2, 'Usage: test-rex-bootstrap-kill.mjs [--live]');
