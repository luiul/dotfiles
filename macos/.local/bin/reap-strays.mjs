import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GRACE_SECONDS = 900;
export const LOG_LIMIT = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const CLASSES = ['zsh', 'gitstatusd', 'context-mode'];
const PS_FIELDS = 'pid=,uid=,ppid=,tty=,lstart=,comm=';
const HELP = `Usage: reap-strays [--dry-run] [--report] | --apply | --help
No arguments: dry run. --report adds precise counts and recent safe events.
Only --apply can send signals or kill registered tmux sessions.
Register a bounded task (does not reap):
  reap-strays --register-tmux ag-NAME --owner PID --deadline EPOCH_SECONDS
`;

export function parseArguments(args) {
  if (args.includes('--register-tmux')) {
    if (args.length !== 6) throw new Error('arguments');
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--register-tmux', '--owner', '--deadline'].includes(args[i]) || values.has(args[i])) throw new Error('arguments');
      values.set(args[i], args[i + 1]);
    }
    const name = values.get('--register-tmux');
    const owner = values.get('--owner');
    const deadline = values.get('--deadline');
    if (!/^ag-[A-Za-z0-9_-]+$/.test(name) || !/^[1-9]\d*$/.test(owner) || !/^[1-9]\d*$/.test(deadline) ||
        Number(owner) <= 1 || !Number.isSafeInteger(Number(owner)) || !Number.isSafeInteger(Number(deadline))) throw new Error('arguments');
    return { register: { name, pid: Number(owner), deadline: Number(deadline) } };
  }
  const allowed = new Set(['--apply', '--dry-run', '--report', '--help']);
  if (new Set(args).size !== args.length || args.some(a => !allowed.has(a))) {
    throw new Error('arguments');
  }
  if (args.includes('--help') && args.length !== 1) throw new Error('arguments');
  if (args.includes('--apply') && args.length !== 1) throw new Error('arguments');
  return { apply: args.includes('--apply'), report: args.includes('--report'), help: args.includes('--help') };
}

// BSD ps prints lstart in the local time zone. Store its epoch seconds, not PID alone.
export function parseProcesses(text) {
  const result = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    const m = line.match(/^\s*(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (!m) throw new Error('ps-format');
    const start = Date.parse(m[5]) / 1000;
    if (!Number.isSafeInteger(start)) throw new Error('ps-start');
    result.push({ pid: Number(m[1]), uid: Number(m[2]), ppid: Number(m[3]), tty: m[4], start, comm: m[6] });
  }
  return result;
}

function commandResult(binary, args, env = process.env) {
  return spawnSync(binary, args, {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    env: { ...env, LC_ALL: 'C' },
  });
}

export function createPs(run = commandResult) {
  function metadata(pid) {
    const args = ['-ww', ...(pid === undefined ? ['-axo', PS_FIELDS] : ['-p', String(pid), '-o', PS_FIELDS])];
    const r = run('/bin/ps', args);
    if (pid !== undefined && r.status === 1 && !r.error && !r.stdout.trim()) return [];
    if (r.error || r.status !== 0) throw new Error('ps-failed');
    return parseProcesses(r.stdout);
  }
  function commands(pid) {
    const r = run('/bin/ps', ['-ww', ...(pid === undefined ? ['-axo', 'pid=,args='] : ['-p', String(pid), '-o', 'pid=,args='])]);
    if (pid !== undefined && r.status === 1 && !r.error && !r.stdout.trim()) return new Map();
    if (r.error || r.status !== 0) throw new Error('ps-failed');
    const map = new Map();
    for (const line of r.stdout.split('\n').filter(l => l.trim())) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) throw new Error('ps-format');
      map.set(Number(m[1]), m[2]);
    }
    return map;
  }
  return {
    snapshot() {
      const rows = metadata();
      const args = commands();
      return rows.map(p => ({ ...p, args: args.get(p.pid) ?? '' }));
    },
    get(pid) {
      const before = metadata(pid)[0];
      if (!before) return null;
      const args = commands(pid).get(pid);
      const after = metadata(pid)[0];
      if (!sameIdentity(before, after) || before.comm !== after.comm || before.ppid !== after.ppid || before.tty !== after.tty || args === undefined) {
        throw new Error('ps-changed');
      }
      return { ...after, args };
    },
  };
}

function knownExecutables(files, names) {
  const set = new Set(names);
  for (const name of names) {
    try { set.add(files.realpathSync(name)); } catch { /* An absent optional runtime is not trusted. */ }
  }
  return set;
}

export function configuration(home = os.homedir(), uid = process.getuid(), files = fs) {
  return {
    uid,
    directory: path.join(home, '.cache/reap-strays'),
    bundle: path.join(home, '.pi/agent/npm/node_modules/context-mode/server.bundle.mjs'),
    gitstatus: path.join(home, `.cache/gitstatus/gitstatusd-darwin-${process.arch}`),
    shells: knownExecutables(files, ['/bin/zsh', '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh']),
    runtimes: knownExecutables(files, ['node', 'bun', '/opt/homebrew/bin/node', '/usr/local/bin/node', path.join(home, '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']),
  };
}

export function sameIdentity(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.uid === b.uid && a.start === b.start);
}

export function processClass(p, config, now, orphanOnly = true) {
  if (p.uid !== config.uid || p.pid <= 1 || !Number.isSafeInteger(p.start) || p.start > now) return null;
  if (orphanOnly && p.ppid !== 1) return null;
  if (p.comm === config.gitstatus) return 'gitstatusd';
  // ps args cannot preserve argv boundaries. Accept only simple, unambiguous argv here.
  const argv = (p.args ?? '').trim().split(/\s+/);
  if (config.runtimes.has(p.comm) && config.runtimes.has(argv[0]) && path.basename(p.comm) === path.basename(argv[0]) && argv[1] === config.bundle) return 'context-mode';
  const comm = p.comm.startsWith('-') ? p.comm.slice(1) : p.comm;
  if (!config.shells.has(comm) || !['??', '?', '-'].includes(p.tty) || now - p.start < 600) return null;
  const loginName = argv[0]?.startsWith('-');
  const argv0 = loginName ? argv[0].slice(1) : argv[0];
  if (argv0 !== 'zsh' && !config.shells.has(argv0)) return null;
  // Never accept -c, script operands, stdin scripts, or complex option syntax.
  if (argv.slice(1).some(a => !/^-[dfil]+$/.test(a))) return null;
  if (!loginName && !argv.slice(1).some(a => /[il]/.test(a))) return null;
  return 'zsh';
}

export function parseTmuxSessions(text) {
  return text.trim() ? text.trimEnd().split('\n').map(line => {
    const a = line.split('|');
    if (a.length !== 6 || !/^\$\d+$/.test(a[0]) || !/^\d+$/.test(a[1]) || !/^\d+$/.test(a[2])) throw new Error('tmux-format');
    return { id: a[0], created: Number(a[1]), attached: Number(a[2]), name: a[3], deadline: a[4], owner: a[5], windows: [] };
  }) : [];
}

export function createTmux(ps, files = fs, run = commandResult) {
  const binary = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find(p => files.existsSync(p));
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  const call = args => run(binary, ['-L', 'default', ...args], env);
  return {
    snapshot() {
      if (!binary) return { sessions: [], server: null, available: false };
      const r = call(['list-sessions', '-F', '#{session_id}|#{session_created}|#{session_attached}|#{session_name}|#{@agent_deadline}|#{@agent_owner}']);
      if (r.error || r.status !== 0) return { sessions: [], server: null, available: false };
      const sessions = parseTmuxSessions(r.stdout);
      const w = call(['list-windows', '-a', '-F', '#{session_id}|#{window_id}']);
      const s = call(['display-message', '-p', '#{pid}']);
      if (w.error || s.error || w.status !== 0 || s.status !== 0 || !/^\d+\s*$/.test(s.stdout)) throw new Error('tmux-read');
      const server = ps.get(Number(s.stdout));
      if (!server) throw new Error('tmux-server');
      for (const line of w.stdout.trimEnd().split('\n')) {
        const a = line.split('|');
        const session = sessions.find(t => t.id === a[0]);
        if (a.length !== 2 || !session || !/^@\d+$/.test(a[1])) throw new Error('tmux-windows');
        session.windows.push(a[1]);
      }
      return { sessions, server, available: true };
    },
    kill(id) {
      // The timeout bounds the tmux client, not the user's session processes.
      const r = call(['kill-session', '-t', id]);
      return !r.error && r.status === 0;
    },
    register(id, owner, deadline) {
      // Clear the deadline first. A failed write must not leave an old expired deadline armed.
      const cleared = call(['set-option', '-t', id, '@agent_deadline', '']);
      if (cleared.error || cleared.status !== 0) return false;
      const owned = call(['set-option', '-t', id, '@agent_owner', owner]);
      if (owned.error || owned.status !== 0) return false;
      const marked = call(['set-option', '-t', id, '@agent_deadline', String(deadline)]);
      return !marked.error && marked.status === 0;
    },
  };
}

export function ownerIdentity(value) {
  const m = value.match(/^([1-9]\d*):([1-9]\d*)$/);
  if (!m || Number(m[1]) <= 1 || !m.slice(1).every(v => Number.isSafeInteger(Number(v)))) return null;
  return { pid: Number(m[1]), start: Number(m[2]) };
}

export function tmuxReason(session, snapshot, config, now, ps) {
  if (!snapshot.server || snapshot.server.uid !== config.uid || !Number.isSafeInteger(snapshot.server.pid) ||
      snapshot.server.pid <= 1 || !Number.isSafeInteger(snapshot.server.start) || snapshot.server.start > now) return 'server-identity';
  if (!/^ag-[A-Za-z0-9_-]+$/.test(session.name)) return 'not-agent';
  if (session.attached !== 0) return 'attached';
  const owner = ownerIdentity(session.owner);
  if (!owner || owner.start > now || !Number.isSafeInteger(session.created) || session.created > now ||
      !/^[1-9]\d*$/.test(session.deadline) || !Number.isSafeInteger(Number(session.deadline)) || Number(session.deadline) < session.created) return 'unmarked';
  if (Number(session.deadline) > now) return 'active-deadline';
  if (!session.windows.length || new Set(session.windows).size !== session.windows.length) return 'ambiguous-windows';
  if (session.windows.some(w => snapshot.sessions.filter(t => t.windows.includes(w)).length !== 1)) return 'shared-windows';
  const current = ps.get(owner.pid);
  if (current && current.start === owner.start) return current.uid === config.uid ? 'live-owner' : 'ambiguous-owner';
  return null; // Absent PID or a different start time proves the original owner is gone.
}

function sameSession(a, b) {
  return Boolean(a && b && ['id', 'created', 'name', 'deadline', 'owner', 'attached'].every(k => a[k] === b[k]) &&
    JSON.stringify([...a.windows].sort()) === JSON.stringify([...b.windows].sort()));
}

function safeFile(files, filename, uid) {
  const s = files.lstatSync(filename);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) throw new Error('private-file');
  return s;
}

function prepareDirectory(files, directory, uid) {
  files.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s = files.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o777) !== 0o700) throw new Error('private-directory');
}

export function acquireLock(files, config, ps = createPs(), selfPid = process.pid) {
  prepareDirectory(files, config.directory, config.uid);
  const lock = path.join(config.directory, 'lock');
  const gate = path.join(config.directory, 'lock-recovery');
  const ownerFile = path.join(lock, 'owner.json');
  const self = ps.get(selfPid);
  if (!self || self.uid !== config.uid || !Number.isSafeInteger(self.start)) throw new Error('lock-self');
  const owner = { pid: self.pid, uid: self.uid, start: self.start };
  const ownerText = JSON.stringify(owner) + '\n';
  function inspect() {
    const stat = files.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== config.uid || (stat.mode & 0o777) !== 0o700) throw new Error('lock-directory');
    if (safeFile(files, ownerFile, config.uid).size > 1024) throw new Error('lock-owner');
    const text = files.readFileSync(ownerFile, 'utf8');
    const identity = JSON.parse(text);
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.uid !== config.uid || !Number.isSafeInteger(identity.start)) throw new Error('lock-owner');
    return { stat, text, identity };
  }
  function absent(identity) {
    const current = ps.get(identity.pid);
    // Read errors throw, never prove absence. Reused PIDs do prove the original owner is gone.
    return !current || current.start !== identity.start;
  }
  function unchanged(a, b) {
    return a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.text === b.text;
  }
  if (files.existsSync(gate)) return null;
  try { files.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { files.mkdirSync(gate, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    let recover = false;
    try {
      const first = inspect();
      if (absent(first.identity)) {
        const second = inspect();
        if (unchanged(first, second) && absent(second.identity) && unchanged(second, inspect())) {
          files.unlinkSync(ownerFile);
          files.rmdirSync(lock);
          recover = true;
        }
      }
    } catch { /* Missing or ambiguous lock metadata needs manual recovery. */ }
    finally { files.rmdirSync(gate); }
    if (!recover) return null;
    // Another writer may win this mkdir. Never remove its new lock.
    try { files.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  }
  const stat = files.lstatSync(lock);
  let fd;
  try {
    fd = files.openSync(ownerFile, 'wx', 0o600);
    files.writeFileSync(fd, ownerText);
    files.fsyncSync(fd);
  } finally { if (fd !== undefined) files.closeSync(fd); }
  return () => {
    const held = inspect();
    if (held.stat.dev !== stat.dev || held.stat.ino !== stat.ino || held.text !== ownerText) throw new Error('lock-changed');
    files.unlinkSync(ownerFile);
    files.rmdirSync(lock);
  };
}

function loadState(files, config) {
  const filename = path.join(config.directory, 'state.json');
  let raw;
  try {
    if (safeFile(files, filename, config.uid).size > MAX_STATE_BYTES) throw new Error('state-size');
    raw = files.readFileSync(filename, 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // Old PID-only state has no verified TERM time. It cannot authorize KILL.
  if (/^\s*(?:\d+\s*)*$/.test(raw)) return [];
  const state = JSON.parse(raw);
  if (state.version !== 2) return [];
  if (!Array.isArray(state.processes)) throw new Error('state-format');
  const ids = new Set();
  for (const p of state.processes) {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 1 || p.uid !== config.uid || !Number.isSafeInteger(p.start) ||
        !CLASSES.includes(p.classification) || !Number.isSafeInteger(p.termAt) || p.termAt < p.start ||
        (p.killAt !== null && (!Number.isSafeInteger(p.killAt) || p.killAt < p.termAt + GRACE_SECONDS)) || ids.has(p.pid)) {
      throw new Error('state-format');
    }
    ids.add(p.pid);
  }
  return state.processes;
}

function atomicState(files, config, processes) {
  const temporary = path.join(config.directory, `state.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = files.openSync(temporary, 'wx', 0o600);
    files.writeFileSync(fd, JSON.stringify({ version: 2, processes }) + '\n');
    files.fsyncSync(fd);
    files.closeSync(fd);
    fd = undefined;
    files.renameSync(temporary, path.join(config.directory, 'state.json'));
  } finally {
    if (fd !== undefined) files.closeSync(fd);
    try { files.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function eventLog(files, config, event) {
  const filename = path.join(config.directory, 'events.log');
  const line = JSON.stringify(event) + '\n';
  let size = 0;
  try { size = safeFile(files, filename, config.uid).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (size + Buffer.byteLength(line) > LOG_LIMIT) {
    for (let i = 3; i >= 1; i--) {
      const old = i === 1 ? filename : `${filename}.${i - 1}`;
      const dest = `${filename}.${i}`;
      try {
        safeFile(files, old, config.uid);
        if (i === 3) { try { safeFile(files, dest, config.uid); files.unlinkSync(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
        files.renameSync(old, dest);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  const fd = files.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { files.writeFileSync(fd, line); } finally { files.closeSync(fd); }
}

export function recentEvents(files, config) {
  try {
    const filename = path.join(config.directory, 'events.log');
    if (safeFile(files, filename, config.uid).size > LOG_LIMIT) return [];
    // Project only numeric fields and enums. Never expose old command-bearing logs.
    return files.readFileSync(filename, 'utf8').trim().split('\n').slice(-6).flatMap(line => {
      try {
        const e = JSON.parse(line);
        if (!['signal', 'tmux'].includes(e.action) || !['success', 'failed'].includes(e.result)) return [];
        return [{ at: Number(e.at), action: e.action, result: e.result,
          ...(e.action === 'signal' ? { pid: Number(e.pid), signal: ['SIGTERM', 'SIGKILL'].includes(e.signal) ? e.signal : 'unknown' } : { id: /^\$\d+$/.test(e.id) ? e.id : 'unknown' }) }];
      } catch { return []; }
    });
  } catch { return []; }
}

export function runReaper(options, dependencies = {}) {
  const files = dependencies.files ?? fs;
  const config = dependencies.config ?? configuration(undefined, undefined, files);
  const ps = dependencies.ps ?? createPs();
  const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1000));
  const signal = dependencies.signal ?? ((pid, sig) => { process.kill(pid, sig); return true; });
  const tmux = dependencies.tmux ?? createTmux(ps, files);
  const write = dependencies.write ?? (s => process.stdout.write(`${s}\n`));
  let release;
  if (options.apply) {
    release = acquireLock(files, config, dependencies.lockPs ?? ps, dependencies.selfPid ?? process.pid);
    if (!release) { write('Skipped: lock held or ambiguous; check private lock metadata.'); return { locked: true }; }
  }
  try {
    const now = clock();
    const rows = ps.snapshot();
    const counts = Object.fromEntries(CLASSES.map(c => [c, { total: 0, orphaned: 0 }]));
    const candidates = [];
    let signalFailed = 0;
    for (const p of rows) {
      const total = processClass(p, config, now, false);
      if (total) counts[total].total++;
      const classification = processClass(p, config, now);
      if (classification) { counts[classification].orphaned++; candidates.push({ ...p, classification }); }
    }
    let state = options.apply ? loadState(files, config) : [];
    if (options.apply) {
      // Reject unsafe log destinations before any process or session action.
      for (const suffix of ['', '.1', '.2', '.3']) {
        try {
          if (safeFile(files, path.join(config.directory, `events.log${suffix}`), config.uid).size > LOG_LIMIT) throw new Error('log-size');
        }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    // State follows PID plus start time and UID. PID reuse resets escalation.
    state = state.filter(p => rows.some(r => sameIdentity(p, r)));
    if (options.apply) atomicState(files, config, state);
    for (const p of candidates) {
      if (!options.apply) { write(`WOULD TERM pid=${p.pid} start=${p.start} class=${p.classification}`); continue; }
      const recorded = state.find(s => sameIdentity(s, p));
      if (recorded?.killAt !== undefined && recorded.killAt !== null) continue;
      const previous = recorded?.classification === p.classification ? recorded : null;
      if (previous && now - previous.termAt < GRACE_SECONDS) continue;
      const sig = previous ? 'SIGKILL' : 'SIGTERM';
      let current;
      try { current = ps.get(p.pid); } catch { write(`Skipped changed/unreadable pid=${p.pid}`); continue; }
      if (!sameIdentity(p, current) || current.comm !== p.comm || processClass(current, config, clock()) !== p.classification ||
          (previous && clock() - previous.termAt < GRACE_SECONDS)) {
        write(`Skipped changed pid=${p.pid}`); continue;
      }
      let success = false;
      try { success = signal(p.pid, sig) === true; } catch { /* Failed TERM never authorizes KILL. */ }
      const at = clock();
      if (!success) signalFailed++;
      if (success) {
        if (previous) previous.killAt = at;
        else {
          state = state.filter(s => s.pid !== p.pid);
          state.push({ pid: p.pid, start: p.start, uid: p.uid, classification: p.classification, termAt: at, killAt: null });
        }
        // Persist before logging. A crash must not erase successful escalation state.
        atomicState(files, config, state);
      }
      eventLog(files, config, { at, action: 'signal', pid: p.pid, uid: p.uid, start: p.start, classification: p.classification, signal: sig, result: success ? 'success' : 'failed' });
      write(`${success ? 'Sent' : 'Failed'} ${sig} pid=${p.pid} class=${p.classification}`);
    }
    let sessions;
    try { sessions = tmux.snapshot(); } catch { sessions = { sessions: [], available: false }; }
    const tmuxCounts = { eligible: 0, skipped: 0, failed: 0, available: sessions.available };
    for (const session of sessions.sessions) {
      let reason;
      try { reason = tmuxReason(session, sessions, config, clock(), ps); } catch { reason = 'unreadable-owner'; }
      if (reason) {
        if (reason !== 'not-agent') { tmuxCounts.skipped++; write(`SKIP tmux id=${session.id} reason=${reason}`); }
        continue;
      }
      tmuxCounts.eligible++;
      if (!options.apply) { write(`WOULD tmux kill-session id=${session.id} (expired, dead owner, detached, private windows)`); continue; }
      let verified = false;
      try {
        const fresh = tmux.snapshot();
        const target = fresh.sessions.find(s => s.id === session.id);
        verified = sameIdentity(sessions.server, fresh.server) && sameSession(session, target) &&
          !tmuxReason(target, fresh, config, clock(), ps);
      } catch { /* Ambiguous sessions stay untouched. */ }
      if (!verified) { tmuxCounts.skipped++; write(`SKIP tmux id=${session.id} reason=changed`); continue; }
      let success = false;
      try { success = tmux.kill(session.id) === true; } catch { /* Timeout and server errors are failures. */ }
      if (!success) tmuxCounts.failed++;
      eventLog(files, config, { at: clock(), action: 'tmux', id: session.id, created: session.created, result: success ? 'success' : 'failed' });
      write(`${success ? 'Killed' : 'Failed'} tmux id=${session.id}`);
    }
    if (options.report) {
      for (const c of CLASSES) write(`${c}: ${counts[c].total} matched total, ${counts[c].orphaned} eligible orphaned`);
      write(`tmux: ${tmuxCounts.eligible} eligible, ${tmuxCounts.skipped} skipped, ${tmuxCounts.available ? 'default server read' : 'default server unavailable'}`);
      write('Recent safe events:');
      const events = recentEvents(files, config);
      if (!events.length) write('(none)');
      for (const event of events) write(JSON.stringify(event));
    }
    if (!candidates.length) write('No eligible orphan processes.');
    return { counts, signalFailed, tmux: tmuxCounts };
  } finally { if (release) release(); }
}

export function registerTmux(task, dependencies = {}) {
  const files = dependencies.files ?? fs;
  const config = dependencies.config ?? configuration(undefined, undefined, files);
  const ps = dependencies.ps ?? createPs();
  const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1000));
  const tmux = dependencies.tmux ?? createTmux(ps, files);
  const write = dependencies.write ?? (s => process.stdout.write(`${s}\n`));
  if (task.deadline <= clock()) throw new Error('registration-deadline');
  const release = acquireLock(files, config, dependencies.lockPs ?? ps, dependencies.selfPid ?? process.pid);
  if (!release) throw new Error('registration-locked');
  try {
    const owner = ps.get(task.pid);
    if (!owner || owner.uid !== config.uid || owner.start > clock()) throw new Error('registration-owner');
    const snapshot = tmux.snapshot();
    const matches = snapshot.sessions.filter(s => s.name === task.name);
    if (!snapshot.available || matches.length !== 1) throw new Error('registration-session');
    const target = matches[0];
    // Use the same private-window, detached and server checks, but require a live owner here.
    const marked = { ...target, deadline: String(clock()), owner: `${owner.pid}:${owner.start}` };
    const reason = tmuxReason(marked, snapshot, config, clock(), ps);
    if (reason !== 'live-owner') throw new Error('registration-safety');
    const fresh = tmux.snapshot();
    const current = fresh.sessions.find(s => s.id === target.id);
    if (!sameIdentity(snapshot.server, fresh.server) || !sameSession(target, current) ||
        !sameIdentity(owner, ps.get(owner.pid)) || task.deadline <= clock()) throw new Error('registration-changed');
    const markedFresh = { ...current, deadline: String(clock()), owner: marked.owner };
    if (tmuxReason(markedFresh, fresh, config, clock(), ps) !== 'live-owner') throw new Error('registration-changed');
    if (tmux.register(target.id, marked.owner, task.deadline) !== true) throw new Error('registration-failed');
    const confirmed = tmux.snapshot();
    const written = confirmed.sessions.find(s => s.id === target.id);
    if (!sameIdentity(snapshot.server, confirmed.server) || !sameSession({ ...target, owner: marked.owner, deadline: String(task.deadline) }, written)) {
      throw new Error('registration-unconfirmed');
    }
    write(`Registered tmux id=${target.id} owner=${marked.owner} deadline=${task.deadline}`);
    return { id: target.id, owner: marked.owner, deadline: task.deadline };
  } finally { release(); }
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const write = dependencies.write ?? (s => process.stdout.write(`${s}\n`));
  let options;
  try { options = parseArguments(args); }
  catch { write('Invalid arguments. Use reap-strays --help.'); return 2; }
  if (options.help) { write(HELP.trimEnd()); return 0; }
  try {
    if (options.register) registerTmux(options.register, { ...dependencies, write });
    else {
      const result = runReaper(options, { ...dependencies, write });
      if (result.locked) return 3;
      if (result.signalFailed || result.tmux.failed) return 1;
    }
    return 0;
  }
  catch { write('Reap-strays stopped safely: process, state, or file check failed.'); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
