import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GRACE_SECONDS, LOG_LIMIT, acquireLock, configuration, createPs, createTmux, main,
  ownerIdentity, parseArguments, parseProcesses, parseTmuxSessions, processClass, recentEvents, registerTmux, runReaper,
} from '../macos/.local/bin/reap-strays.mjs';

const engine = fileURLToPath(new URL('../macos/.local/bin/reap-strays.mjs', import.meta.url));
const now = 1800000000;
const uid = process.getuid();
let count = 0;
const fixtureDirectories = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'test-reap-strays-'));
  fixtureDirectories.push(home);
  const config = configuration(home, uid);
  let seconds = now;
  let rows = [];
  let lookup;
  let failSignal = false;
  const signals = [];
  const output = [];
  const tmuxKills = [];
  let tmuxSnapshot = { available: true, server: { pid: 9000, uid, start: now - 1000 }, sessions: [] };
  const files = new Proxy(fs, { get: (target, key) => target[key] });
  const dependencies = {
    config, files, clock: () => seconds,
    selfPid: 8000,
    lockPs: { get: pid => pid === 8000 ? { pid: 8000, uid, start: now - 2000 } : null },
    ps: { snapshot: () => rows.map(r => ({ ...r })), get: pid => lookup ? lookup(pid) : rows.find(p => p.pid === pid) ?? null },
    signal: (pid, sig) => { signals.push([pid, sig]); if (failSignal) throw new Error('fixture'); return true; },
    tmux: { snapshot: () => structuredClone(tmuxSnapshot), kill: id => { tmuxKills.push(id); return true; },
      register: (id, owner, deadline) => {
        const target = tmuxSnapshot.sessions.find(s => s.id === id);
        if (!target) return false;
        target.owner = owner; target.deadline = String(deadline); return true;
      } },
    write: s => output.push(s),
  };
  return {
    home, config, dependencies, signals, output, tmuxKills,
    set rows(r) { rows = r; }, get rows() { return rows; },
    set lookup(f) { lookup = f; }, set time(t) { seconds = t; }, set failSignal(f) { failSignal = f; },
    set tmux(s) { tmuxSnapshot = s; }, get tmux() { return tmuxSnapshot; },
    run: options => runReaper({ apply: true, ...options }, dependencies),
    state: () => JSON.parse(fs.readFileSync(path.join(config.directory, 'state.json'), 'utf8')).processes,
    proc: (extra = {}) => ({ pid: 3000, uid, ppid: 1, tty: '??', start: now - 1200, comm: '/bin/zsh', args: '/bin/zsh -il', ...extra }),
  };
}
function test(name, fn) {
  fn(); count++; console.log(`PASS ${name}`);
}
function session(extra = {}) {
  return { id: '$1', created: now - 1000, attached: 0, name: 'ag-fixture', deadline: String(now - 1), owner: `6000:${now - 1200}`, windows: ['@1'], ...extra };
}

try {
  test('strict arguments, safe help, and read-only default', () => {
    assert.deepEqual(parseArguments([]), { apply: false, report: false, help: false });
    for (const args of [['--wat'], ['--apply', '--help'], ['--apply', '--report'], ['--apply', '--dry-run'], ['--apply', '--apply'], ['--help', '--dry-run'], ['--dry-run=1']]) {
      const f = fixture();
      assert.equal(main(args, f.dependencies), 2);
      assert.equal(f.signals.length, 0);
      assert.equal(fs.existsSync(f.config.directory), false);
    }
    const f = fixture();
    f.dependencies.ps.snapshot = () => { throw new Error('must not read ps for help'); };
    assert.equal(main(['--help'], f.dependencies), 0);
    assert.equal(fs.existsSync(f.config.directory), false);
  });
  test('BSD ps parser records exact executable and start identity', () => {
    const rows = parseProcesses(' 3000 502 1 ?? Sun Oct 25 18:09:23 2026 /bin/zsh\n 3001 502 1 ?? Sun Oct 25 18:09:23 2026 -/bin/zsh\n');
    assert.equal(rows[0].comm, '/bin/zsh');
    assert.equal(rows[1].comm, '-/bin/zsh');
    assert.ok(Number.isSafeInteger(rows[0].start));
    assert.equal(parseProcesses('19523 -2 19504 ?? Fri Oct 23 21:55:58 2026 /Library/Application Support/Google/Chrome\n')[0].uid, -2);
    assert.throws(() => parseProcesses('truncated row'));
    assert.throws(() => parseProcesses('3000 502 1 ?? Sun Bad 25 18:09:23 2026 /bin/zsh'));
  });
  test('Ghostty historical false matches never classify', () => {
    const f = fixture();
    const args = '/Applications/Ghostty.app/Contents/MacOS/ghostty -e /bin/zsh -ic exec pi gitstatusd server.bundle.mjs';
    for (const comm of ['/Applications/Ghostty.app/Contents/MacOS/ghostty', '/Applications/Ghostty.app/Contents/MacOS/Ghostty', '/bin/sh', '/bin/echo']) {
      assert.equal(processClass(f.proc({ comm, args }), f.config, now), null);
    }
    f.rows = [f.proc({ comm: '/Applications/Ghostty.app/Contents/MacOS/ghostty', args })];
    f.run(); assert.deepEqual(f.signals, []);
  });
  test('shell age, UID, actual executable, tty and unambiguous interactive/login flags', () => {
    const f = fixture();
    for (const args of ['/bin/zsh -i', '/bin/zsh -l', '-zsh', '-/bin/zsh', '/bin/zsh -fil']) {
      assert.equal(processClass(f.proc({ args }), f.config, now), 'zsh', args);
    }
    for (const args of ['/bin/zsh', '/bin/zsh task.zsh', '/bin/zsh -c sleep', '/bin/zsh -ic exec pi', '/bin/zsh -lc script', '/bin/zsh -i -c x', '/bin/zsh -il script.zsh', '/bin/zsh -f', '/bin/zsh -s', '/bin/zsh --login', '/bin/zsh -o interactive', '/bin/zsh -i --', 'other -i']) {
      assert.equal(processClass(f.proc({ args }), f.config, now), null, args);
    }
    for (const extra of [{ uid: uid + 1 }, { ppid: 2 }, { tty: 'ttys000' }, { start: now - 599 }, { comm: '/tmp/zsh' }, { pid: 1 }, { start: now + 1 }]) {
      assert.equal(processClass(f.proc(extra), f.config, now), null);
    }
    assert.equal(processClass(f.proc({ start: now - 600 }), f.config, now), 'zsh');
  });
  test('gitstatus exact cache binary and bundle entrypoint only', () => {
    const f = fixture();
    assert.equal(processClass(f.proc({ comm: f.config.gitstatus }), f.config, now), 'gitstatusd');
    for (const comm of [`${f.config.gitstatus}.old`, '/tmp/gitstatusd', '/bin/echo']) {
      assert.equal(processClass(f.proc({ comm, args: f.config.gitstatus }), f.config, now), null);
    }
    const bridge = f.proc({ comm: 'node', args: `node ${f.config.bundle}` });
    assert.equal(processClass(bridge, f.config, now), 'context-mode');
    for (const args of ['node /unrelated/server.bundle.mjs', `node /tmp/other.mjs ${f.config.bundle}`, `node -e ${f.config.bundle}`, `node ${f.config.bundle}.old`, `echo ${f.config.bundle}`]) {
      assert.equal(processClass({ ...bridge, args }, f.config, now), null, args);
    }
    assert.equal(processClass({ ...bridge, uid: uid + 1 }, f.config, now), null);
    assert.equal(processClass({ ...bridge, comm: '/tmp/node' }, f.config, now), null);
  });
  test('TERM succeeds before grace; KILL waits 900 seconds and remains recorded', () => {
    const f = fixture(); f.rows = [f.proc()]; f.run();
    assert.deepEqual(f.signals, [[3000, 'SIGTERM']]);
    assert.equal(f.state()[0].termAt, now);
    f.time = now + GRACE_SECONDS - 1; f.run();
    assert.equal(f.signals.length, 1);
    f.time = now + GRACE_SECONDS; f.run();
    assert.deepEqual(f.signals[1], [3000, 'SIGKILL']);
    assert.equal(f.state()[0].killAt, now + GRACE_SECONDS);
    f.time = now + GRACE_SECONDS * 2; f.run();
    assert.equal(f.signals.length, 2);
    f.rows = []; f.run(); assert.deepEqual(f.state(), []);
    assert.equal(fs.statSync(f.config.directory).mode & 0o777, 0o700);
    for (const name of ['state.json', 'events.log']) assert.equal(fs.statSync(path.join(f.config.directory, name)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(f.config.directory, 'lock')), false);
  });
  test('TERM failure cannot escalate, KILL failure retries with original TERM', () => {
    const f = fixture(); f.rows = [f.proc()]; f.failSignal = true; f.run();
    assert.deepEqual(f.state(), []);
    f.time = now + 1800; f.failSignal = false; f.run();
    assert.deepEqual(f.signals[1], [3000, 'SIGTERM']);
    f.time = now + 2700; f.failSignal = true; f.run();
    assert.equal(f.state()[0].killAt, null);
    f.failSignal = false; f.run();
    assert.deepEqual(f.signals.at(-1), [3000, 'SIGKILL']);
    assert.ok(f.output.some(s => s.startsWith('Failed SIGTERM')));
  });
  test('PID reuse starts a fresh TERM, including after successful KILL', () => {
    const f = fixture(); f.rows = [f.proc()]; f.run();
    f.time = now + 900; f.run();
    f.time = now + 2000; f.rows = [f.proc({ start: now + 1000 })]; f.run();
    assert.deepEqual(f.signals.at(-1), [3000, 'SIGTERM']);
    assert.equal(f.state()[0].start, now + 1000);
    assert.equal(f.state()[0].termAt, now + 2000);
  });
  test('final reread rejects PID reuse, owner UID, parent and class changes', () => {
    for (const extra of [{ start: now - 1000 }, { uid: uid + 1 }, { ppid: 2 }, { comm: '/Applications/Ghostty.app/Contents/MacOS/ghostty' }, { tty: 'ttys004' }, { args: '/bin/zsh -c sleep' }]) {
      const f = fixture(); f.rows = [f.proc()]; f.lookup = () => f.proc(extra); f.run();
      assert.deepEqual(f.signals, []);
    }
    const f = fixture(); f.rows = [f.proc()]; f.run(); f.time = now + 900;
    f.lookup = () => f.proc({ start: now - 1000 }); f.run();
    assert.equal(f.signals.length, 1);
  });
  test('old PID-only state cannot authorize KILL and dry runs never mutate', () => {
    const f = fixture(); f.rows = [f.proc()];
    fs.mkdirSync(path.join(f.home, '.cache'), { recursive: true });
    const legacy = path.join(f.home, '.cache/strays-termed');
    fs.writeFileSync(legacy, '3000\n');
    f.run({ apply: false, report: true });
    assert.equal(fs.existsSync(f.config.directory), false);
    assert.deepEqual(f.signals, []);
    fs.mkdirSync(f.config.directory, { mode: 0o700 });
    fs.writeFileSync(path.join(f.config.directory, 'state.json'), '3000\n', { mode: 0o600 });
    f.run(); assert.deepEqual(f.signals, [[3000, 'SIGTERM']]);
    const before = fs.readFileSync(path.join(f.config.directory, 'state.json'));
    f.time = now + 1800; f.run({ apply: false, report: true });
    assert.deepEqual(fs.readFileSync(path.join(f.config.directory, 'state.json')), before);
    assert.equal(fs.readFileSync(legacy, 'utf8'), '3000\n');
    assert.equal(f.signals.length, 1);
  });
  test('private state checks, corrupt state and symlinks fail closed', () => {
    for (const mode of [0o644, 0o666]) {
      const f = fixture(); f.rows = [f.proc()]; fs.mkdirSync(f.config.directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(f.config.directory, 'state.json'), '{}', { mode });
      assert.equal(main(['--apply'], f.dependencies), 1); assert.deepEqual(f.signals, []);
    }
    const f = fixture(); f.rows = [f.proc()]; fs.mkdirSync(f.config.directory, { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(f.home, 'elsewhere'), path.join(f.config.directory, 'state.json'));
    assert.equal(main(['--apply'], f.dependencies), 1); assert.deepEqual(f.signals, []);
    assert.equal(fs.existsSync(path.join(f.config.directory, 'lock')), false);
  });
  test('atomic state write failure before TERM makes no destructive call', () => {
    const f = fixture(); f.rows = [f.proc()];
    f.dependencies.files = new Proxy(fs, { get(target, key) { return key === 'renameSync' ? () => { throw new Error('fixture write failure'); } : target[key]; } });
    assert.equal(main(['--apply'], f.dependencies), 1);
    assert.deepEqual(f.signals, []);
    assert.equal(fs.existsSync(path.join(f.config.directory, 'lock')), false);
    assert.equal(fs.readdirSync(f.config.directory).some(n => n.endsWith('.tmp')), false);
  });
  test('lock denies concurrent writers and releases on errors', () => {
    const f = fixture(); const release = acquireLock(fs, f.config, f.dependencies.lockPs, 8000);
    assert.equal(acquireLock(fs, f.config, f.dependencies.lockPs, 8000), null);
    f.rows = [f.proc()]; assert.equal(f.run().locked, true); assert.deepEqual(f.signals, []);
    release(); f.dependencies.ps.snapshot = () => { throw new Error('fixture ps failed'); };
    assert.equal(main(['--apply'], f.dependencies), 1);
    assert.equal(fs.existsSync(path.join(f.config.directory, 'lock')), false);
  });
  test('failed signals and tmux cleanup exit nonzero; a held lock returns 3', () => {
    const term = fixture(); term.rows = [term.proc()]; term.failSignal = true;
    assert.equal(main(['--apply'], term.dependencies), 1);
    assert.deepEqual(term.state(), []);
    const kill = fixture(); kill.rows = [kill.proc()]; kill.run(); kill.time = now + 900; kill.failSignal = true;
    assert.equal(main(['--apply'], kill.dependencies), 1);
    assert.equal(kill.state()[0].killAt, null);
    const tmux = fixture(); tmux.tmux.sessions = [session()]; tmux.dependencies.tmux.kill = () => false;
    assert.equal(main(['--apply'], tmux.dependencies), 1);
    const locked = fixture(); const release = acquireLock(fs, locked.config, locked.dependencies.lockPs, 8000);
    assert.equal(main(['--apply'], locked.dependencies), 3); release();
  });
  test('dead or reused lock owner recovers, live/ambiguous/changed owner never does', () => {
    for (const scenario of ['absent', 'reused', 'live', 'foreign', 'error', 'revived', 'metadata-changed']) {
      const f = fixture();
      const prior = { pid: 7000, uid, start: now - 3000 };
      const lock = path.join(f.config.directory, 'lock');
      fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
      const ownerFile = path.join(lock, 'owner.json');
      fs.writeFileSync(ownerFile, JSON.stringify(prior) + '\n', { mode: 0o600 });
      let reads = 0;
      const ps = { get(pid) {
        if (pid === 8000) return { pid: 8000, uid, start: now - 2000 };
        reads++;
        if (scenario === 'error') throw new Error('fixture ps unavailable');
        if (scenario === 'metadata-changed' && reads === 1) fs.writeFileSync(ownerFile, JSON.stringify({ ...prior, start: now - 2500 }) + '\n');
        if (scenario === 'live' || scenario === 'foreign' || (scenario === 'revived' && reads > 1)) return { ...prior, uid: scenario === 'foreign' ? uid + 1 : uid };
        if (scenario === 'reused') return { ...prior, start: now - 1000 };
        return null;
      } };
      const release = acquireLock(fs, f.config, ps, 8000);
      if (['absent', 'reused'].includes(scenario)) {
        assert.ok(release, scenario);
        assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile)), { pid: 8000, uid, start: now - 2000 });
        assert.equal(fs.statSync(ownerFile).mode & 0o777, 0o600);
        release();
      } else {
        assert.equal(release, null, scenario);
        assert.equal(fs.existsSync(lock), true);
      }
      assert.equal(fs.existsSync(path.join(f.config.directory, 'lock-recovery')), false);
    }
    const incomplete = fixture();
    fs.mkdirSync(path.join(incomplete.config.directory, 'lock'), { recursive: true, mode: 0o700 });
    assert.equal(acquireLock(fs, incomplete.config, incomplete.dependencies.lockPs, 8000), null);
    const gated = fixture();
    fs.mkdirSync(path.join(gated.config.directory, 'lock-recovery'), { recursive: true, mode: 0o700 });
    assert.equal(acquireLock(fs, gated.config, gated.dependencies.lockPs, 8000), null);
  });
  test('log rotation is bounded and no command arguments escape into logs/reports', () => {
    const f = fixture(); f.rows = [f.proc({ comm: f.config.gitstatus, args: 'SENSITIVE_TOKEN=never-log-this' })];
    f.run();
    const log = path.join(f.config.directory, 'events.log');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(log, 'x'.repeat(LOG_LIMIT - 1) + '\n');
      f.rows = [f.proc({ pid: 3100 + i, comm: f.config.gitstatus, args: 'SENSITIVE_TOKEN=never-log-this' })]; f.run();
    }
    const logs = fs.readdirSync(f.config.directory).filter(n => n.startsWith('events.log'));
    assert.equal(logs.length, 4);
    for (const name of logs) {
      const filename = path.join(f.config.directory, name);
      assert.ok(fs.statSync(filename).size <= LOG_LIMIT);
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(filename, 'utf8').includes('SENSITIVE_TOKEN'), false);
    }
    fs.writeFileSync(log, JSON.stringify({ at: now, action: 'signal', result: 'success', pid: 3000, signal: 'SIGTERM', command: 'SENSITIVE_TOKEN' }) + '\n');
    assert.equal(JSON.stringify(recentEvents(fs, f.config)).includes('SENSITIVE_TOKEN'), false);
    f.run({ apply: false, report: true });
    assert.equal(f.output.join('\n').includes('SENSITIVE_TOKEN'), false);
  });
  test('precise report counts exclude unrelated executables and other users', () => {
    const f = fixture();
    f.rows = [f.proc({ comm: f.config.gitstatus }), f.proc({ pid: 3001, ppid: 500, comm: f.config.gitstatus }),
      f.proc({ pid: 3002, comm: 'node', args: `node ${f.config.bundle}` }),
      f.proc({ pid: 3003, comm: 'node', args: 'node /unrelated/server.bundle.mjs' }),
      f.proc({ pid: 3004, uid: uid + 1, comm: f.config.gitstatus })];
    const report = f.run({ apply: false, report: true });
    assert.deepEqual(report.counts.gitstatusd, { total: 2, orphaned: 1 });
    assert.deepEqual(report.counts['context-mode'], { total: 1, orphaned: 1 });
    assert.deepEqual(f.signals, []); assert.equal(fs.existsSync(f.config.directory), false);
  });
  test('ps final read detects changes across argument read and rejects read failures', () => {
    let call = 0;
    const row = pid => ` ${pid} ${uid} 1 ?? Sun Oct 25 18:09:23 2026 /bin/zsh\n`;
    const ps = createPs(() => {
      call++;
      return { status: 0, stdout: call === 2 ? '3000 /bin/zsh -i\n' : row(call === 3 ? 3001 : 3000) };
    });
    assert.throws(() => ps.get(3000));
    assert.throws(() => createPs(() => ({ status: 1, stdout: '', error: new Error('timed out') })).get(3000));
    assert.equal(createPs(() => ({ status: 1, stdout: '' })).get(3000), null);
  });
  test('tmux unmarked, active, attached, shared and live-owner sessions stay intact', () => {
    for (const [extra, expected] of [
      [{ deadline: '', owner: '' }, 'unmarked'], [{ owner: '6000' }, 'unmarked'],
      [{ deadline: String(now + 1) }, 'active-deadline'], [{ attached: 1 }, 'attached'],
      [{ windows: [] }, 'ambiguous-windows'], [{ windows: ['@1', '@1'] }, 'ambiguous-windows'],
    ]) {
      const f = fixture(); f.tmux.sessions = [session(extra)]; f.run();
      assert.deepEqual(f.tmuxKills, []); assert.ok(f.output.some(s => s.includes(`reason=${expected}`)));
    }
    const shared = fixture(); shared.tmux.sessions = [session(), session({ id: '$2', name: 'daily', windows: ['@1'] })]; shared.run();
    assert.deepEqual(shared.tmuxKills, []); assert.ok(shared.output.some(s => s.includes('shared-windows')));
    const live = fixture(); live.rows = [live.proc({ pid: 6000, ppid: 50 })]; live.tmux.sessions = [session()]; live.run();
    assert.deepEqual(live.tmuxKills, []); assert.ok(live.output.some(s => s.includes('live-owner')));
    const unreadable = fixture(); unreadable.tmux.sessions = [session()]; unreadable.lookup = () => { throw new Error('fixture ps failed'); }; unreadable.run();
    assert.deepEqual(unreadable.tmuxKills, []);
  });
  test('expired detached registered tmux session with dead or reused owner is eligible', () => {
    for (const reused of [false, true]) {
      const f = fixture(); f.tmux.sessions = [session()];
      if (reused) f.rows = [f.proc({ pid: 6000, ppid: 50, start: now - 1100 })];
      f.run({ apply: false }); assert.deepEqual(f.tmuxKills, []);
      f.run(); assert.deepEqual(f.tmuxKills, ['$1']);
    }
    assert.equal(ownerIdentity('1:100'), null);
    assert.equal(ownerIdentity('6000:1 trailing'), null);
    assert.deepEqual(ownerIdentity(`6000:${now - 1200}`), { pid: 6000, start: now - 1200 });
  });
  test('tmux final session options, server identity, owner and links are rechecked', () => {
    for (const extra of [{ owner: `7000:${now - 1200}` }, { deadline: String(now + 60) }, { attached: 1 }, { created: now - 900 }, { name: 'ag-replacement' }, { windows: ['@2'] }]) {
      const f = fixture(); let calls = 0;
      f.dependencies.tmux.snapshot = () => ({ ...f.tmux, sessions: [session(++calls > 1 ? extra : {})] });
      f.run(); assert.deepEqual(f.tmuxKills, []);
    }
    const owner = fixture(); owner.tmux.sessions = [session()]; let reads = 0;
    owner.lookup = () => ++reads > 1 ? owner.proc({ pid: 6000, ppid: 50 }) : null;
    owner.run(); assert.deepEqual(owner.tmuxKills, []);
    const server = fixture(); let calls = 0;
    server.dependencies.tmux.snapshot = () => ({ ...server.tmux, server: { ...server.tmux.server, start: now - (++calls > 1 ? 900 : 1000) }, sessions: [session()] });
    server.run(); assert.deepEqual(server.tmuxKills, []);
    const links = fixture(); let linkCalls = 0;
    links.dependencies.tmux.snapshot = () => ({ ...links.tmux, sessions: ++linkCalls > 1 ? [session(), session({ id: '$2', name: 'daily' })] : [session()] });
    links.run(); assert.deepEqual(links.tmuxKills, []);
  });
  test('tmux failed cleanup reports failure and adapter uses only default server', () => {
    const f = fixture(); f.tmux.sessions = [session()]; f.dependencies.tmux.kill = () => false;
    assert.equal(f.run().tmux.failed, 1);
    assert.ok(f.output.some(s => s === 'Failed tmux id=$1'));
    assert.equal(recentEvents(fs, f.config).at(-1).result, 'failed');
    const calls = [];
    const tmux = createTmux({ get: () => ({ pid: 9000, uid, start: now - 1000 }) }, { existsSync: () => true }, (binary, args, env) => {
      calls.push({ binary, args, env });
      assert.deepEqual(args.slice(0, 2), ['-L', 'default']);
      assert.equal(env.TMUX, undefined); assert.equal(env.TMUX_TMPDIR, undefined);
      switch (args[2]) {
        case 'list-sessions': return { status: 0, stdout: `$1|${now - 1000}|0|ag-test|${now - 1}|6000:${now - 1200}\n` };
        case 'list-windows': return { status: 0, stdout: '$1|@1\n' };
        case 'display-message': return { status: 0, stdout: '9000\n' };
        case 'kill-session': return { status: null, error: new Error('fixture timeout') };
        default: throw new Error('unexpected tmux call');
      }
    });
    assert.equal(tmux.snapshot().sessions[0].owner, `6000:${now - 1200}`);
    assert.equal(tmux.kill('$1'), false);
    assert.equal(calls.at(-1).args.at(-1), '$1');
  });

  test('KILL retention survives classification changes and backward clocks do not escalate', () => {
    const f = fixture(); f.rows = [f.proc()]; f.run();
    f.time = now - 60; f.run(); assert.equal(f.signals.length, 1);
    f.time = now + 900; f.run();
    f.rows = [f.proc({ comm: f.config.gitstatus })]; f.time = now + 1800; f.run();
    assert.equal(f.signals.length, 2); assert.ok(f.state()[0].killAt);
  });
  test('tmux pipe format keeps empty options; ambiguous delimiter input fails closed', () => {
    const rows = parseTmuxSessions(`$1|${now - 1000}|0|ag-test||\n`);
    assert.equal(rows[0].deadline, ''); assert.equal(rows[0].owner, '');
    assert.throws(() => parseTmuxSessions(`$1|${now - 1000}|0|ag-test|invalid|owner|extra\n`));
  });
  test('registration pins live owner identity and deadline without signals or cleanup', () => {
    const f = fixture(); f.rows = [f.proc({ pid: 6000, ppid: 50 })];
    f.tmux.sessions = [session({ owner: '', deadline: '' })];
    const task = { name: 'ag-fixture', pid: 6000, deadline: now + 600 };
    assert.deepEqual(registerTmux(task, f.dependencies), { id: '$1', owner: `6000:${now - 1200}`, deadline: now + 600 });
    assert.equal(f.tmux.sessions[0].owner, `6000:${now - 1200}`);
    assert.equal(f.tmux.sessions[0].deadline, String(now + 600));
    assert.deepEqual(f.signals, []); assert.deepEqual(f.tmuxKills, []);
    assert.equal(main(['--register-tmux', 'ag-fixture', '--owner', '6000', '--deadline', String(now + 1000)], f.dependencies), 0);
  });
  test('registration rejects invalid args, expired deadlines, dead/foreign/reused owners and active/shared sessions', () => {
    for (const args of [
      ['--register-tmux', 'daily', '--owner', '6000', '--deadline', String(now + 600)],
      ['--register-tmux', 'ag-test', '--owner', '1', '--deadline', String(now + 600)],
      ['--register-tmux', 'ag-test', '--owner', '6000', '--deadline', 'nan'],
      ['--register-tmux', 'ag-test', '--owner', '6000'],
      ['--register-tmux', 'ag-test', '--owner', '6000', '--apply', '1'],
      ['--register-tmux', 'ag-test', '--owner', '6000', '--owner', '6001'],
    ]) assert.throws(() => parseArguments(args));
    for (const variant of ['expired', 'dead', 'foreign', 'attached', 'shared', 'reused', 'changed-options', 'write-failed']) {
      const f = fixture(); f.rows = variant === 'dead' ? [] : [f.proc({ pid: 6000, ppid: 50, ...(variant === 'foreign' ? { uid: uid + 1 } : {}) })];
      f.tmux.sessions = [session({ owner: '', deadline: '', ...(variant === 'attached' ? { attached: 1 } : {}) })];
      if (variant === 'shared') f.tmux.sessions.push(session({ id: '$2', name: 'daily' }));
      if (variant === 'reused') {
        let reads = 0; f.lookup = () => f.proc({ pid: 6000, ppid: 50, start: ++reads > 2 ? now - 1000 : now - 1200 });
      }
      if (variant === 'changed-options') {
        let reads = 0; f.dependencies.tmux.snapshot = () => ({ ...f.tmux, sessions: [session({ owner: '', deadline: ++reads > 1 ? String(now + 1000) : '' })] });
      }
      if (variant === 'write-failed') f.dependencies.tmux.register = () => false;
      assert.throws(() => registerTmux({ name: 'ag-fixture', pid: 6000, deadline: variant === 'expired' ? now : now + 600 }, f.dependencies), variant);
      assert.deepEqual(f.signals, []); assert.deepEqual(f.tmuxKills, []);
    }
  });
  test('registration adapter clears old deadline before owner and future deadline', () => {
    const calls = [];
    const tmux = createTmux({}, { existsSync: () => true }, (_binary, args) => { calls.push(args); return { status: 0 }; });
    assert.equal(tmux.register('$1', `6000:${now - 1200}`, now + 600), true);
    assert.deepEqual(calls.map(args => args.slice(-2)), [
      ['@agent_deadline', ''], ['@agent_owner', `6000:${now - 1200}`], ['@agent_deadline', String(now + 600)],
    ]);
    let reads = 0;
    const failed = createTmux({}, { existsSync: () => true }, () => ({ status: ++reads === 2 ? 1 : 0 }));
    assert.equal(failed.register('$1', `6000:${now - 1200}`, now + 600), false);
    assert.equal(reads, 2);
  });

  // Two independent Node processes exercise the actual filesystem lock. No ps or signals run.
  const concurrency = fixture();
  const childCode = `import fs from 'node:fs'; import {acquireLock} from ${JSON.stringify(`file://${engine}`)}; const release=acquireLock(fs,${JSON.stringify(concurrency.config, (key, value) => value instanceof Set ? [...value] : value)}); if(!release)process.exit(2); console.log('locked'); setTimeout(()=>{release();process.exit(0)},1500);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('exit', code => { if (code !== 0) reject(new Error(`lock child failed ${code}`)); });
  });
  assert.equal(acquireLock(fs, concurrency.config), null);
  const finished = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(finished, 0);
  const release = acquireLock(fs, concurrency.config); assert.ok(release); release();
  count++; console.log('PASS actual cross-process lock concurrency');

  // Safe CLI-only invocations do not read ps, signal processes, or connect to tmux.
  for (const args of [['--help'], ['--unknown'], ['--apply', '--dry-run']]) {
    const result = spawnSync(process.execPath, [engine, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, args[0] === '--help' ? 0 : 2);
    assert.equal(result.signal, null);
  }
  count++; console.log('PASS CLI argument exit codes');
  console.log(`${count} fixture tests passed. No real signals or tmux cleanup calls.`);
} finally {
  for (const directory of fixtureDirectories) fs.rmSync(directory, { recursive: true, force: true });
}
