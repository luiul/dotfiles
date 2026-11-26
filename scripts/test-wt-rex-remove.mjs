import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zshrc = readFileSync(join(root, 'zsh/.zshrc'), 'utf8');
const start = zshrc.indexOf('if (( $+functions[wt] && ! $+functions[_wt_shell_orig] )); then');
const end = zshrc.indexOf('\nfi\n', start);
assert.ok(start >= 0 && end > start, 'Worktrunk wrapper not found');
const q = value => `'${value.replaceAll("'", "'\\''")}'`;
const wt = execFileSync('/bin/zsh', ['-fc', 'whence -p wt'], { encoding: 'utf8', timeout: 5000 }).trim();
const cop = execFileSync('/bin/zsh', ['-fc', 'whence -p cop'], { encoding: 'utf8', timeout: 5000 }).trim();
const fixture = await RexTestDriver.start({ deadlineMs: 1200000 });
try {
  const { binary, endpoint } = fixture.manifest();
  const rex = (...args) => execFileSync(binary, ['--autostart=false', '-S', endpoint, ...args], {
    encoding: 'utf8', timeout: 15000,
  });
  const json = (...args) => JSON.parse(rex(...args));
  const home = join(fixture.root, 'home');
  const repo = join(fixture.root, 'Main repo');
  const bin = join(fixture.root, 'bin');
  for (const directory of [home, repo, bin]) mkdirSync(directory);
  const env = {
    HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const config = join(fixture.root, 'wt.toml');
  const worktreePath = join(fixture.root, 'checkouts', '{{ branch }}');
  writeFileSync(config, `worktree-path = ${JSON.stringify(worktreePath)}\n`);
  const splitMarker = join(fixture.root, 'concurrent-split');
  const injectSplit = `if [ -n "\${TEST_REX_SPLIT:-}" ] && [ "\${6-}" = do ]; then\n` +
    `  ${q(binary)} --autostart=false --timeout 2s -S ${q(endpoint)} split -s "$REX_SESSION" -b "$REX_BLOCK" -c ${q(repo)} --json -- /bin/zsh -f > ${q(splitMarker)} || exit 1\nfi\n`;
  writeFileSync(join(bin, 'rex'), `#!/bin/sh\n${injectSplit}exec ${q(binary)} -S ${q(endpoint)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'wt'), `#!/bin/sh\nexec ${q(wt)} --config ${q(config)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'coppice'), `#!/bin/sh\nexec ${q(cop)} "$@"\n`, { mode: 0o700 });
  const run = (executable, ...args) => execFileSync(executable, args, { cwd: repo, env, encoding: 'utf8', timeout: 45000 });
  run('git', 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'tracked'), 'original\n');
  run('git', 'add', 'tracked');
  run('git', '-c', 'user.name=Fixture', '-c', 'user.email=wt@example.invalid', 'commit', '-qm', 'initial');

  const shellSetup = join(fixture.root, 'setup.zsh');
  writeFileSync(shellSetup, `eval "$(command wt config shell init zsh)"\n` +
    `source ${q(join(root, 'zsh/.zsh_config/funcs_rex.zsh'))}\n${zshrc.slice(start, end + 4)}\n` +
    'eval "$(command coppice shell init zsh)"\n_wt_rex_wrap_coppice\nalias cop=coppice\n' +
    // Completion refresh tests belong to the completion cache suite.
    '_wt_comp_warm() { :; }\n');
  const shell = ['/usr/bin/env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), '/bin/zsh', '-f'];
  const session = json('new', 'Rex removal test', '-c', repo, '--window', 'Unrelated', '--json', '--', ...shell);
  const id = session.session_id;
  const unrelated = session.initial_windows[0].window_id;
  const inspect = () => json('session', 'inspect', id, '--json');
  const send = (block, text) => {
    rex('send', '-s', id, '-b', block, text);
    rex('send-key', '-s', id, '-b', block, 'enter');
  };
  async function wait(message, check) {
    const until = Date.now() + 45000;
    do {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 180));
    } while (Date.now() < until);
    assert.fail(message);
  }
  for (const scenario of ['caller', 'foreground', 'other', 'dirty', 'split', 'job', 'override', 'late-split', 'cop-caller', 'cop-dirty', 'cop-other', 'cop-split', 'cop-job', 'cop-override', 'cop-reinit', 'cop-agent', 'cop-subshell']) {
    const checkout = join(fixture.root, 'checkouts', scenario);
    run('wt', 'switch', '--create', scenario, '--base', 'main', '--no-cd', '--yes');
    const here = scenario.endsWith('other') ? repo : checkout;
    const tab = json('window', 'new', '-s', id, scenario, '-c', here, '--json', '--', ...shell);
    const block = tab.block_ids[0];
    if (['split', 'cop-split'].includes(scenario)) rex('split', '-s', id, '-b', block, '-c', repo, '--', ...shell);
    if (scenario.endsWith('dirty')) writeFileSync(join(checkout, 'tracked'), 'keep my edit\n');
    const ready = join(fixture.root, `${scenario}.ready`);
    const done = join(fixture.root, `${scenario}.done`);
    send(block, `source ${q(shellSetup)} && print ready > ${q(ready)}`);
    await wait(`shell did not load in ${scenario}`, () => existsSync(ready));
    if (['job', 'cop-job'].includes(scenario)) send(block, 'sleep 60 &');
    if (['override', 'cop-override'].includes(scenario)) send(block, `export REX_BLOCK=${q(session.initial_windows[0].block_ids[0])}`);
    if (scenario === 'cop-agent') send(block, 'export WORKTRUNK_AGENT=1');
    if (scenario === 'cop-reinit') send(block, 'eval "$(command coppice shell init zsh)"; _wt_rex_wrap_coppice');
    if (scenario === 'late-split') send(block, 'export TEST_REX_SPLIT=1');
    const flags = ['foreground', 'other', 'dirty'].includes(scenario) ? ' --foreground' : '';
    let command = scenario.startsWith('cop-')
      ? `cop remove ${scenario} --repo ${q(repo)} --yes`
      : `wt remove ${scenario === 'other' ? 'other' : ''}${flags} --yes`;
    if (scenario === 'cop-subshell') command = `(${command})`;
    send(block, `${command}; print -r -- $? > ${q(done)}; pwd > ${q(done + '.pwd')}`);
    if (['caller', 'foreground', 'cop-caller', 'cop-reinit'].includes(scenario)) {
      try {
        await wait('removed worktree tab did not close', () => !inspect().windows.some(win => win.window_id === tab.window_id));
      } catch (error) {
        console.error(rex('capture', '-s', id, '-b', block, '--trim', '--unwrap'));
        throw error;
      }
    } else if (scenario === 'late-split') {
      try {
        await wait('only the caller should close in a concurrent split', () => {
          const callerTab = inspect().windows.find(win => win.window_id === tab.window_id);
          return existsSync(splitMarker) && callerTab?.layers.flatMap(layer => layer.blocks)
            .every(pane => pane.block_id !== block);
        });
      } catch (error) {
        const callerTab = inspect().windows.find(win => win.window_id === tab.window_id);
        console.error('concurrent split marker:', existsSync(splitMarker) && readFileSync(splitMarker, 'utf8'));
        if (callerTab?.layers.some(layer => layer.blocks.some(pane => pane.block_id === block))) {
          console.error(rex('capture', '-s', id, '-b', block, '--trim', '--unwrap'));
        }
        throw error;
      }
      const receipt = JSON.parse(readFileSync(splitMarker, 'utf8'));
      const callerTab = inspect().windows.find(win => win.window_id === tab.window_id);
      const remaining = callerTab.layers.flatMap(layer => layer.blocks);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].block_id, receipt.block_id ?? receipt.block_ids?.[0], JSON.stringify(receipt));
    } else {
      await wait(`wt did not finish in ${scenario}`, () => existsSync(done));
      assert.equal(readFileSync(done, 'utf8').trim(), scenario.endsWith('dirty') ? '1' : '0');
      assert.ok(inspect().windows.some(win => win.window_id === tab.window_id), `lost ${scenario} tab`);
      if (scenario === 'cop-split') {
        await wait('cop did not move the retained split shell', () => existsSync(done + '.pwd'));
        assert.equal(readFileSync(done + '.pwd', 'utf8').trim(), repo);
      }
    }
    await wait(`checkout state for ${scenario}`, () => existsSync(checkout) === scenario.endsWith('dirty'));
    if (scenario.endsWith('dirty')) assert.equal(readFileSync(join(checkout, 'tracked'), 'utf8'), 'keep my edit\n');
    assert.ok(inspect().windows.some(win => win.window_id === unrelated), 'unrelated tab disappeared');
  }
  console.log('PASS: foreground and background removal close only a verified idle single-pane caller');

  for (const scenario of ['last-tab', 'last-tab-foreground', 'cop-last-tab', 'last-tab-detached']) {
    const checkout = join(fixture.root, 'checkouts', scenario);
    run('wt', 'switch', '--create', scenario, '--base', 'main', '--no-cd', '--yes');
    const host = fixture.create({ name: scenario, command: ['/bin/zsh', '-f'], cwd: checkout, env, columns: 120, rows: 40 });
    const ready = join(fixture.root, `${scenario}.ready`);
    // The driver's env -i deliberately strips Rex's injected caller context.
    // Restore only the exact private host IDs before loading the shell hooks.
    fixture.text(host, `export REX_SESSION=${q(host.sessionId)} REX_BLOCK=${q(host.blockId)} REX_SERVER=${q(endpoint)}; source ${q(shellSetup)} && print ready > ${q(ready)}`);
    fixture.key(host, 'enter');
    await wait(`shell did not load in ${scenario}`, () => existsSync(ready));
    const flags = scenario.endsWith('foreground') ? ' --foreground' : '';
    let detached;
    if (scenario === 'last-tab-detached') {
      const tab = json('window', 'new', '-s', host.sessionId, 'Detached worker', '-c', repo, '--json', '--', ...shell);
      detached = tab.block_ids[0];
      fixture.api('session.detach_block', { session_id: host.sessionId, block_id: detached });
    }
    const command = scenario.startsWith('cop-')
      ? `cop remove ${scenario} --repo ${q(repo)} --yes`
      : `wt remove${flags} --yes`;
    fixture.text(host, command);
    fixture.key(host, 'enter');
    await wait(`last-tab checkout was not removed in ${scenario}`, () => !existsSync(checkout));
    if (detached) {
      await wait('last visible tab did not close with a detached worker', () => {
        const view = fixture.api('session.view', { session_id: host.sessionId });
        return !view.windows?.length;
      });
      const remaining = fixture.api('session.list_blocks', { session_id: host.sessionId });
      assert.deepEqual(remaining.blocks.map(block => block.block_id), [detached]);
      const process = fixture.api('block.method', {
        session_id: host.sessionId, block_id: detached, method: 'process', args: {},
      });
      assert.ok(process.last_exit == null, 'detached worker stopped');
      assert.ok(Number.isInteger(process.child?.pid) && process.child.pid > 0, 'detached worker has no process');
    } else {
      await wait(`last-tab session did not close in ${scenario}`, () => {
        const listing = json('session', 'ls', '--json');
        const sessions = Array.isArray(listing) ? listing : listing.sessions;
        return !sessions.some(session => session.session_id === host.sessionId);
      });
    }
    assert.ok(inspect().windows.some(win => win.window_id === unrelated), 'unrelated session disappeared');
  }
  console.log('PASS: last-tab removal closes empty sessions, but preserves detached workers and unrelated sessions');
} finally {
  await fixture.stop();
}
