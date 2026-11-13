#!/usr/bin/env node
// Owned fixture test: real app/Core, private Rex, no desktop Rex endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { RexTestDriver } from './rex-test-driver.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync(fs.mkdtempSync('/tmp/wt-herdr-remove-live-'));
const repo = path.join(root, 'repo');
const env = { ...process.env, WORKTRUNK_AGENT: '1', WT_HERDR_STATE_HOME: root + '/state/wt-herdr' };
for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
const run = (b, a, cwd = repo, timeout = 15000) => execFileSync(b, a, { cwd, env, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
const json = (b, a, cwd) => JSON.parse(run(b, a, cwd));
const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (check, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await pause(200); }
  throw Error('Timed out: ' + label);
};
fs.mkdirSync(repo);
const before = json('herdr-app', ['ls']);
const focus = json('herdr-app', ['status']);
const refs = x => x.spaces.flatMap(s => s.tabs.flatMap(t => (t.terminals || []).map(p => p.terminal)));
const ownedSpaces = [], ownedTerms = [], branches = [];
let driver, failed = false;
const bin = root + '/bin'; fs.mkdirSync(bin);
const config = root + '/wt.toml';
fs.writeFileSync(config, `worktree-path = "${root}/worktrees/{{ branch }}/repo"\n[pre-remove]\nherdr = '${source}/worktrunk/.local/bin/wt-herdr prepare-remove --path {{ worktree_path }}'\n[post-remove]\nherdr = '${source}/worktrunk/.local/bin/wt-herdr finish-remove --path {{ worktree_path }}'\n`);
fs.writeFileSync(bin + '/wt', `#!/bin/sh\nexec /opt/homebrew/bin/wt --config ${quote(config)} "$@"\n`, { mode: 0o755 });
env.PATH = bin + ':' + env.PATH;
const create = branch => {
  run('wt', ['switch', '--create', branch, '--no-cd', '--yes', '--format', 'json']);
  branches.push(branch);
  return root + '/worktrees/' + branch + '/repo';
};
const shell = target => {
  const c = json('herdr-app', ['do', 'space.new', JSON.stringify({ name: 'Owned removal test', folder: target, machine: '' })]);
  ownedSpaces.push(c.space); ownedTerms.push(c.terminal); return c;
};
async function send(t, cmd, marker) {
  run('hc', ['send', t, cmd], repo, 75000);
  try { await wait(() => fs.existsSync(marker), 'Herdr shell command', 110000); }
  catch (e) { console.log('Owned caller screen ' + run('hc', ['read', '--lines', '25', t])); throw e; }
  return fs.readFileSync(marker, 'utf8').trim();
}
async function removeRex(mode, branch, target, extra = '') {
  const host = driver.create({ name: 'remove-' + mode, command: ['/bin/zsh', '-l'], cwd: mode === 'wt' ? target : repo,
    env: { HOME: process.env.HOME, PATH: env.PATH, WT_HERDR_STATE_HOME: env.WT_HERDR_STATE_HOME, WORKTRUNK_AGENT: '1', TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' }, columns: 140, rows: 36 });
  await wait(() => driver.pid(host), 'registered shell');
  const ready = root + '/' + branch + '-ready';
  driver.text(host, 'export PATH=' + quote(env.PATH) + '; print -r -- "$PWD" > ' + quote(ready)); driver.key(host, 'enter');
  await wait(() => fs.existsSync(ready), 'real shell readiness');
  const result = root + '/' + branch + '-result';
  const cmd = mode === 'wt' ? `wt remove --yes ${extra}` : `cop remove ${branch} --repo ${quote(repo)} --yes ${extra}`;
  driver.text(host, cmd + '; print -r -- "$?" > ' + quote(result)); driver.key(host, 'enter');
  await wait(() => fs.existsSync(result), 'removal completed', 45000);
  const rc = fs.readFileSync(result, 'utf8').trim();
  if (rc !== '0') console.log('Removal screen ' + driver.capture(host, { history: true }).slice(-3500));
  driver.close(host); return rc;
}
try {
  run('git', ['init', '--initial-branch=main', repo]);
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture baseline']);
  driver = await RexTestDriver.start({ deadlineMs: 900000 });
  for (const mode of ['wt', 'cop']) {
    const branch = 'idle-' + mode, target = create(branch), c = shell(target);
    const idle = root + '/' + branch + '-idle';
    await send(c.terminal, 'print -r -- "$PWD" > ' + quote(idle), idle);
    assert.equal(await removeRex(mode, branch, target), '0');
    await wait(() => !json('herdr-app', ['ls']).spaces.some(s => s.id === c.space), mode + ' space closure', 60000);
    assert(!fs.existsSync(target));
    console.log('PASS ' + mode + ': idle space closes after removal');
  }
  // A real Pi in another tab must block even with force flags.
  const branch = 'other-tab', target = create(branch), c = shell(target);
  const second = json('hc', ['run', '--bg', '--no-notify', '--no-parent', '--cwd', target, '--label', 'herdr.space=' + c.space, '--label', 'herdr.tab=remove-other-tab', '--', run('/usr/bin/which', ['pi']).trim(), '--no-extensions']);
  const address = second.terminal || second.address; assert(address); ownedTerms.push(address);
  await wait(() => json('herdr-app', ['ls']).spaces.find(s => s.id === c.space)?.tabs.some(t => t.terminals?.some(p => p.terminal === address)), 'other tab adoption');
  assert.notEqual(await removeRex('wt', branch, target, '--force --force-delete'), '0');
  assert(fs.existsSync(target));
  assert(json('herdr-app', ['ls']).spaces.some(s => s.id === c.space));
  assert.equal(json('hc', ['get', address]).state, 'live');
  console.log('PASS real Pi in another tab blocks deletion and preserves work');
  run('hc', ['kill', address]);
  // A shell prompt does not mean it has no background jobs.
  const background = create('background-job'), bgSpace = shell(background);
  const bgReady = root + '/bg-ready';
  run('hc', ['send', bgSpace.terminal, 'sleep 300 &'], repo, 75000);
  run('hc', ['keys', bgSpace.terminal, 'enter']);
  await send(bgSpace.terminal, `print -r -- $! > ${quote(bgReady)}`, bgReady);
  assert.notEqual(await removeRex('cop', 'background-job', background), '0');
  assert(fs.existsSync(background));
  assert.equal(json('hc', ['get', bgSpace.terminal]).state, 'live');
  console.log('PASS idle-looking shell with background job blocks cop removal');
  const stopBg = root + '/bg-stopped';
  await send(bgSpace.terminal, `kill $(cat ${quote(bgReady)}); print stopped > ${quote(stopBg)}`, stopBg);
  // Native failed removal must leave the entire Herdr conversation intact.
  const dirty = create('dirty'), dirtySpace = shell(dirty);
  fs.writeFileSync(dirty + '/untracked', 'preserve');
  assert.notEqual(await removeRex('wt', 'dirty', dirty), '0');
  assert(fs.existsSync(dirty + '/untracked'));
  assert(json('herdr-app', ['ls']).spaces.some(s => s.id === dirtySpace.space));
  fs.unlinkSync(dirty + '/untracked');
  console.log('PASS dirty removal preserves checkout and space');
  // Opt-out keeps Herdr spaces intact but does not skip other Worktrunk hooks.
  const opt = create('opt-out'), optSpace = shell(opt);
  env.WT_HERDR_REMOVE = '0';
  run('wt', ['remove', 'opt-out', '--yes', '--foreground']);
  delete env.WT_HERDR_REMOVE;
  assert(!fs.existsSync(opt));
  assert(json('herdr-app', ['ls']).spaces.some(s => s.id === optSpace.space));
  console.log('PASS feature opt-out preserves the space');
  // Navigate within an existing shared space, then remove the current checkout.
  // The original-checkout Pi stays live; a second Pi in the target still blocks.
  for (const mode of ['wt', 'cop']) {
    const original = create('shared-original-' + mode);
    const targetBranch = 'shared-target-' + mode, target = create(targetBranch);
    const shared = shell(original);
    const agent = json('hc', ['run', '--bg', '--no-notify', '--no-parent', '--cwd', original,
      '--label', 'herdr.space=' + shared.space, '--label', 'herdr.tab=shared-agent-' + mode,
      '--', run('/usr/bin/which', ['pi']).trim(), '--no-extensions']);
    const agentAddress = agent.terminal || agent.address; assert(agentAddress); ownedTerms.push(agentAddress);
    await wait(() => json('herdr-app', ['ls']).spaces.find(s => s.id === shared.space)?.tabs.some(t => t.terminals?.some(p => p.terminal === agentAddress)), 'shared unrelated agent adoption');
    const agentBefore = json('hc', ['get', agentAddress]);
    const ready = root + '/shared-' + mode + '-ready';
    assert.equal(await send(shared.terminal, `export PATH=${quote(env.PATH)} WT_HERDR_STATE_HOME=${quote(env.WT_HERDR_STATE_HOME)}; cd ${quote(target)}; print -r -- "$PWD" > ${quote(ready)}`, ready), target);
    await wait(() => json('hc', ['get', shared.terminal]).foreground?.cwd === target, 'shared caller checkout reporting');
    if (mode === 'wt') {
      const blocked = json('hc', ['run', '--bg', '--no-notify', '--no-parent', '--cwd', target,
        '--label', 'herdr.space=' + shared.space, '--label', 'herdr.tab=shared-target-agent',
        '--', run('/usr/bin/which', ['pi']).trim(), '--no-extensions']);
      const blocker = blocked.terminal || blocked.address; assert(blocker); ownedTerms.push(blocker);
      await wait(() => json('herdr-app', ['ls']).spaces.find(s => s.id === shared.space)?.tabs.some(t => t.terminals?.some(p => p.terminal === blocker)), 'shared target agent adoption');
      const refused = root + '/shared-blocked-result';
      assert.notEqual(await send(shared.terminal, `wt remove --yes --force --force-delete; print -r -- "$?" > ${quote(refused)}`, refused), '0');
      assert(fs.existsSync(target));
      assert.equal(json('hc', ['get', blocker]).state, 'live');
      run('hc', ['kill', blocker]);
      await wait(() => !json('herdr-app', ['ls']).spaces.find(s => s.id === shared.space)?.tabs.some(t => t.terminals?.some(p => p.terminal === blocker)), 'stopped target agent pane removed');
      console.log('PASS shared-space target agent blocks current-checkout deletion');
    }
    const result = root + '/shared-' + mode + '-result';
    const command = mode === 'wt' ? 'wt remove' : `cop remove ${targetBranch} --repo ${quote(repo)} --yes`;
    const answer = await send(shared.terminal, `${command}; rc=$?; printf '%s\\n%s\\n' "$rc" "$PWD" > ${quote(result)}`, result);
    const [rc, cwd] = answer.split('\n');
    if (rc !== '0') console.log('Shared caller failure ' + run('hc', ['read', '--lines', '30', shared.terminal]));
    assert.equal(rc, '0');
    await wait(() => !fs.existsSync(target), 'shared target removed');
    if (mode === 'wt') assert.equal(cwd, repo);
    const after = json('herdr-app', ['ls']).spaces.find(s => s.id === shared.space);
    assert(after, 'Shared space must survive'); assert.equal(after.folder, original);
    assert(after.tabs.some(t => t.terminals?.some(p => p.terminal === agentAddress)));
    const agentAfter = json('hc', ['get', agentAddress]);
    assert.equal(agentAfter.state, 'live'); assert.equal(agentAfter.pid, agentBefore.pid);
    assert.equal(agentAfter.cwd, original);
    assert.equal(json('hc', ['get', shared.terminal]).state, 'live');
    console.log('PASS ' + mode + ': removal from current checkout preserves shared space and unrelated Pi');
  }
  // Real caller in its own target space. Never close while its remover is still running.
  for (const mode of ['wt', 'cop']) {
    const selfBranch = 'same-space-' + mode;
    const self = create(selfBranch), selfSpace = shell(self);
    const selfReady = root + '/' + selfBranch + '-ready';
    await send(selfSpace.terminal, `export PATH=${quote(env.PATH)} WT_HERDR_STATE_HOME=${quote(env.WT_HERDR_STATE_HOME)}; print -r -- "$PWD" > ${quote(selfReady)}`, selfReady);
    const command = mode === 'wt' ? 'wt remove --yes' : `cop remove ${selfBranch} --repo ${quote(repo)} --yes`;
    run('hc', ['send', selfSpace.terminal, command], repo, 75000);
    try { await wait(() => !json('herdr-app', ['ls']).spaces.some(s => s.id === selfSpace.space), mode + ' caller-owned space closes', 90000); }
    catch (e) { console.log('Owned removal caller screen ' + run('hc', ['read', '--lines', '30', selfSpace.terminal])); throw e; }
    assert(!fs.existsSync(self));
    console.log('PASS ' + mode + ' removal caller settles before its space closes');
  }
} catch (e) {
  failed = true; console.log('FAIL ' + String(e.stderr || e.stack));
  try {
    const records = fs.readdirSync(env.WT_HERDR_STATE_HOME).filter(n => n.endsWith('.remove.json'));
    console.log('Cleanup records ' + JSON.stringify(records));
    const logs = run('git', ['rev-parse', '--git-common-dir']).trim() + '/wt/logs';
    if (fs.existsSync(repo + '/' + logs)) console.log('Log directory ' + repo + '/' + logs);
  } catch {}
} finally {
  for (const id of ownedSpaces) try { if (json('herdr-app', ['ls']).spaces.some(s => s.id === id)) run('herdr-app', ['do', 'space.close', JSON.stringify({ id, confirmed: true })]); } catch (e) { failed = true; console.log('Space cleanup failed ' + id); }
  for (const t of ownedTerms) try { const f = json('hc', ['get', t]); if (f.state === 'live') run('hc', ['kill', t]); run('hc', ['rm', t]); } catch (e) { if (!/not_found/.test(String(e.stderr))) { failed = true; console.log('Terminal cleanup failed ' + t); } }
  if (driver) try { await driver.stop(); console.log('Private Rex teardown verified'); } catch (e) { failed = true; console.log('Rex cleanup failed ' + e); }
  env.WT_HERDR_REMOVE = '0';
  for (const b of branches) try { if (run('git', ['worktree', 'list', '--porcelain']).includes('branch refs/heads/' + b + '\n')) run('wt', ['remove', b, '--foreground', '--yes']); } catch { failed = true; console.log('Worktree cleanup failed ' + b); }
  try {
    const after = json('herdr-app', ['ls']);
    assert.equal(after.spaces.filter(s => ownedSpaces.includes(s.id)).length, 0);
    assert.deepEqual(refs(before).filter(t => !refs(after).includes(t)), []);
    if (focus.focused_pane) run('herdr-app', ['do', 'pane.focus', JSON.stringify({ pane: focus.focused_pane })]);
    console.log('Original terminals preserved, owned spaces absent');
  } catch (e) { failed = true; console.log('Final layout check failed ' + e); }
  if (!failed) fs.rmSync(root, { recursive: true });
  else console.log('Evidence retained ' + root);
}
process.exitCode = failed ? 1 : 0;
