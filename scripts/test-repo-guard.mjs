#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../git/.local/bin/repo-guard', import.meta.url));
const require = createRequire(import.meta.url);
const api = require(cli);
const owned = new Set();
const integrations = new Set();
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-tests-')));
const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Guard Test', GIT_AUTHOR_EMAIL: 'guard@example.invalid', GIT_COMMITTER_NAME: 'Guard Test', GIT_COMMITTER_EMAIL: 'guard@example.invalid' };
for (const key of Object.keys(env)) if (/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_|WORKTRUNK_)/.test(key)) delete env[key];
function exec(command, args, cwd, extra = {}) {
  return execFileSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const git = (cwd, ...args) => exec('git', args, cwd);
function write(cwd, file, content) { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), content); }
function commit(cwd, file, content) { write(cwd, file, content); git(cwd, 'add', '--', file); git(cwd, 'commit', '-m', 'test: fixture change'); return git(cwd, 'rev-parse', 'HEAD'); }
function fixture({ defaultBranch = 'main', hf = false, remote = true } = {}) {
  const dir = fs.mkdtempSync(path.join(sandbox, 'fixture-')); owned.add(dir);
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, hf ? 'hellofresh/repo' : 'primary'), feature = path.join(dir, 'feature'), config = path.join(dir, 'wt.toml');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', `--initial-branch=${defaultBranch}`);
  git(root, 'config', 'user.name', 'Guard Test'); git(root, 'config', 'user.email', 'guard@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.config/wt.toml', 'pre-start = "touch MUST_NOT_RUN"\npost-start = "touch MUST_NOT_RUN_EITHER"\n');
  write(root, '.gitignore', 'ignored/\n');
  write(root, 'base', 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: baseline');
  fs.writeFileSync(config, 'skip-shell-integration-prompt = true\n');
  const wtEnv = { WORKTRUNK_AGENT: '1', WORKTRUNK_SYSTEM_CONFIG_PATH: config };
  if (remote) {
    git(dir, 'init', '--bare', `--initial-branch=${defaultBranch}`, origin);
    git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-u', 'origin', defaultBranch);
    git(root, 'remote', 'set-head', 'origin', '--auto');
  }
  exec('wt', ['--config', config, '-C', root, 'switch', '--create', 'feature', '--base=HEAD', '--path', feature, '--no-cd', '--no-hooks', '--yes', '--format=json'], root, wtEnv);
  return { dir, origin, root, feature, config, wtEnv, defaultBranch };
}
function remember(result) {
  if (result?.integration) {
    const dir = path.dirname(result.integration);
    assert.ok(path.basename(dir).startsWith('publish-') && path.basename(path.dirname(dir)) === 'repo-guard-integrations' && dir.startsWith(`${sandbox}/`));
    integrations.add(dir);
  }
}
function guard(cwd, args, extra = {}) {
  let stdout, code = 0;
  try { stdout = exec(process.execPath, [cli, '--cwd', cwd, ...args, '--json'], cwd, extra); }
  catch (error) { code = error.status ?? 1; stdout = error.stdout?.toString().trim(); if (!stdout) throw error; }
  const result = JSON.parse(stdout); remember(result);
  return { code, ...result };
}
const publish = (f, verify = 'true', extra) => guard(f.feature, ['publish', '--approved', '--verify', verify], extra);
async function waitFor(file) {
  const end = Date.now() + 15000;
  while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error(`No marker: ${file}`); await new Promise(r => setTimeout(r, 25)); }
}
function backgroundGuard(cwd, args, extra = {}) {
  const child = spawn(process.execPath, [cli, '--cwd', cwd, ...args, '--json'], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  const done = new Promise((resolve, reject) => child.on('close', code => {
    clearTimeout(timer);
    try { const result = JSON.parse(out.trim()); remember(result); resolve({ code, ...result }); }
    catch { reject(new Error(`No JSON result (${code}): ${out} ${err}`)); }
  }));
  return { child, done };
}
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const remoteHead = f => git(f.root, 'ls-remote', 'origin', `refs/heads/${f.defaultBranch}`).split(/\s/)[0];
function external(f) {
  const dir = path.join(f.dir, 'external'); git(f.dir, 'clone', f.origin, dir);
  git(dir, 'config', 'commit.gpgsign', 'false'); return dir;
}
function ghProof(f, data) {
  const bin = path.join(f.dir, 'bin'), json = path.join(f.dir, 'proof.json');
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(json, JSON.stringify(data));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(json)}));\n`, { mode: 0o755 });
  // Git still talks only to our local bare remote. gh sees the canonical GitHub URL.
  git(f.root, 'config', `url.${f.origin}.insteadOf`, 'https://github.com/hellofresh/repo.git');
  git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/hellofresh/repo.git');
  return { PATH: `${bin}:${env.PATH}` };
}
function mergedData(head, merge, { repo = 'hellofresh/repo', base = 'main', state = 'MERGED', prRepo = repo } = {}) {
  return { data: { repository: { nameWithOwner: repo, pullRequests: { nodes: [{ state, headRefOid: head, mergeCommit: { oid: merge }, baseRefName: base, baseRepository: { nameWithOwner: prRepo }, headRepository: { nameWithOwner: prRepo } }] } } } };
}

test('relative filesystem origin stays frozen across source and integration directories', () => {
  const f = fixture(); const head = commit(f.feature, 'relative-feature', 'preserve destination');
  git(f.root, 'remote', 'set-url', 'origin', '../origin.git');
  const primary = git(f.root, 'rev-parse', 'HEAD');
  const result = publish(f);
  assert.equal(result.code, 0, result.error);
  assert.equal(remoteHead(f), head);
  assert.equal(git(f.feature, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), primary);
});

test('imports are inert; parser and NUL status paths have no data content', () => {
  assert.equal(typeof api.main, 'function');
  assert.deepEqual(api.parseDirty('R  new name\0old name\0?? weird\nname\0 M sub\0'), [{ path: 'new name', status: 'R ' }, { path: 'weird\nname', status: '??' }, { path: 'sub', status: ' M' }]);
  assert.throws(() => api.parse(['publish', '--verify', 'true']), /approved/);
  assert.throws(() => api.parse(['publish', '--approved']), /verify/);
  assert.throws(() => api.parse(['status', '--force']), /Unknown/);
});

test('status is exact, local only, cached publication is never remote proof', () => {
  const f = fixture();
  let result = guard(f.feature, ['status']); assert.equal(result.code, 0);
  const { code, ...contract } = result;
  assert.deepEqual(Object.keys(contract).sort(), ['root', 'commonDir', 'branch', 'head', 'dirty', 'upstream', 'ahead', 'behind', 'defaultBranch', 'isHelloFresh', 'publication', 'operation'].sort());
  assert.equal(result.upstream, null); assert.equal(result.ahead, null); assert.equal(result.behind, null);
  assert.equal(result.defaultBranch, 'main'); assert.equal(result.publication, 'cached');
  write(f.feature, 'new\nfile', 'do not expose');
  write(f.feature, 'base', 'do not expose');
  result = guard(f.feature, ['status']);
  assert.equal(result.dirty.length, 2); assert.ok(!JSON.stringify(result).includes('do not expose'));
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
  assert.equal(guard(f.feature, ['check-remove', '--force']).code, 1);
  fs.renameSync(f.origin, `${f.origin}.offline`);
  assert.equal(guard(f.root, ['status']).code, 0);
  assert.equal(guard(f.root, ['status']).publication, 'cached');
  git(f.feature, 'reset', '--hard'); fs.unlinkSync(path.join(f.feature, 'new\nfile'));
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
  fs.renameSync(`${f.origin}.offline`, f.origin);
  git(f.feature, 'branch', '--set-upstream-to=origin/main');
  commit(f.feature, 'ahead', 'local commit');
  result = guard(f.feature, ['status']); assert.equal(result.ahead, 1); assert.equal(result.behind, 0); assert.equal(result.upstream, 'origin/main');
  git(f.feature, 'mv', 'base', 'renamed');
  result = guard(f.feature, ['status']); assert.ok(result.dirty.some(d => d.path === 'renamed' && d.status[0] === 'R'));
});

test('unpublished, missing origin, unknown default, and protected paths fail closed', () => {
  const f = fixture({ defaultBranch: 'trunk' });
  assert.equal(guard(f.root, ['check-remove']).code, 1);
  assert.equal(guard(f.feature, ['check-remove']).code, 0);
  commit(f.feature, 'feature', 'unpublished');
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
  git(f.feature, 'push', 'origin', 'feature'); // personal feature publication is not sufficient
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
  git(f.origin, 'symbolic-ref', 'HEAD', 'refs/heads/absent');
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
  const none = fixture({ remote: false });
  assert.equal(guard(none.feature, ['status']).defaultBranch, null);
  assert.equal(guard(none.feature, ['check-remove']).code, 1);
  assert.equal(publish(none).code, 1);
  const protectedFixture = fixture();
  git(protectedFixture.feature, 'branch', '-m', 'live');
  assert.match(guard(protectedFixture.feature, ['check-remove']).error, /Protected/);
});

test('detached HEAD requires exact ancestry, ignored files warn, dirty submodules block', () => {
  const f = fixture();
  git(f.feature, 'checkout', '--detach');
  write(f.feature, 'ignored/keep', 'ignored data');
  let result = guard(f.feature, ['check-remove']); assert.equal(result.code, 0); assert.ok(result.warnings.length);
  assert.equal(fs.readFileSync(path.join(f.feature, 'ignored/keep'), 'utf8'), 'ignored data');
  commit(f.feature, 'new', 'detached unpublished'); assert.equal(guard(f.feature, ['check-remove']).code, 1);
  const sub = path.join(f.dir, 'sub-source'); fs.mkdirSync(sub);
  git(sub, 'init'); commit(sub, 'subfile', 'base');
  git(f.feature, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'sub');
  git(f.feature, 'commit', '-am', 'test: submodule');
  write(f.feature, 'sub/subfile', 'dirty');
  result = guard(f.feature, ['status']); assert.ok(result.dirty.some(d => d.path === 'sub'));
  assert.equal(guard(f.feature, ['check-remove']).code, 1);
});

test('clean publish preserves source and primary until explicit refresh, and runs no setup hooks', () => {
  const f = fixture({ defaultBranch: 'trunk' });
  const primaryBefore = git(f.root, 'rev-parse', 'HEAD');
  const source = commit(f.feature, 'feature', 'feature');
  const result = publish(f, 'test -f feature && test ! -f MUST_NOT_RUN && test ! -f MUST_NOT_RUN_EITHER');
  assert.equal(result.code, 0, result.error); assert.equal(result.published, true); assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'Explicit refresh pending');
  assert.equal(result.candidate, source); assert.equal(git(f.feature, 'rev-parse', 'HEAD'), source);
  assert.equal(git(f.feature, 'status', '--porcelain'), ''); assert.equal(remoteHead(f), source);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), primaryBefore); assert.equal(result.integration, null);
  assert.equal(result.cleanup, 'removed'); assert.equal(guard(f.feature, ['check-remove']).code, 0);
  assert.equal(guard(f.feature, ['refresh', '--approved']).refreshed, true);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), source);
});

test('publishing from primary never advances that frozen source implicitly', () => {
  const f = fixture(); const source = commit(f.root, 'source', 'primary source');
  const e = external(f); commit(e, 'remote', 'remote advance'); git(e, 'push');
  const result = guard(f.root, ['publish', '--approved', '--verify', 'true']);
  assert.equal(result.code, 0, result.error); assert.equal(result.refreshed, false);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), source); assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.notEqual(remoteHead(f), source); assert.equal(result.cleanup, 'removed');
});

test('dirty primary defers without touching index or files; explicit refresh is safe', () => {
  const f = fixture(); const base = git(f.root, 'rev-parse', 'HEAD');
  const source = commit(f.feature, 'feature', 'feature');
  write(f.root, 'base', 'primary staged edit'); git(f.root, 'add', 'base');
  write(f.root, 'base', 'primary unstaged edit'); write(f.root, 'untracked', 'keep');
  const index = git(f.root, 'write-tree'), before = git(f.root, 'status', '--porcelain');
  const result = publish(f); assert.equal(result.code, 0, result.error); assert.equal(result.refreshed, false);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), base); assert.equal(git(f.root, 'write-tree'), index);
  assert.equal(git(f.root, 'status', '--porcelain'), before); assert.equal(fs.readFileSync(path.join(f.root, 'base'), 'utf8'), 'primary unstaged edit');
  assert.equal(guard(f.root, ['refresh', '--approved']).refreshed, false);
  git(f.root, 'reset', '--hard'); fs.unlinkSync(path.join(f.root, 'untracked'));
  const refresh = guard(f.feature, ['refresh', '--approved']); assert.equal(refresh.code, 0); assert.equal(refresh.refreshed, true);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), source);
});

test('refresh preserves ignored collisions with newly tracked incoming paths', () => {
  const f = fixture(); const e = external(f);
  write(e, 'ignored/collision', 'incoming tracked data');
  git(e, 'add', '-f', 'ignored/collision'); git(e, 'commit', '-m', 'test: ignored tracked collision'); git(e, 'push');
  write(f.root, 'ignored/collision', 'precious ignored local data');
  const before = git(f.root, 'rev-parse', 'HEAD'), index = git(f.root, 'write-tree');
  const result = guard(f.feature, ['refresh', '--approved']);
  assert.equal(result.code, 1); assert.match(result.error, /overwritten/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(git(f.root, 'write-tree'), index);
  assert.equal(fs.readFileSync(path.join(f.root, 'ignored/collision'), 'utf8'), 'precious ignored local data');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
});

test('assume-unchanged and skip-worktree flags block removal, publication, and refresh without clearing them', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture();
    git(f.feature, 'update-index', flag, 'base'); write(f.feature, 'base', 'hidden local edit');
    assert.equal(git(f.feature, 'status', '--porcelain'), '');
    const state = guard(f.feature, ['status']);
    assert.ok(state.dirty.some(d => d.path === 'base' && d.status.startsWith('index:')));
    for (const args of [['check-remove'], ['publish', '--approved', '--verify', 'true'], ['refresh', '--approved']]) {
      const result = guard(f.feature, args); assert.equal(result.code, 1); assert.match(result.error, /Unsupported index flags/);
    }
    assert.equal(fs.readFileSync(path.join(f.feature, 'base'), 'utf8'), 'hidden local edit');
    assert.match(git(f.feature, 'ls-files', '-v', 'base'), flag === '--skip-worktree' ? /^S / : /^h /);
    git(f.root, 'update-index', flag, 'base'); write(f.root, 'base', 'primary hidden edit');
    assert.match(guard(f.root, ['refresh', '--approved']).error, /Unsupported index flags/);
    // Flags remain unsupported even when their paths were not modified.
    fs.writeFileSync(path.join(f.feature, 'base'), 'base\n');
    assert.equal(guard(f.feature, ['check-remove']).code, 1);
  }
});

test('ordinary integration merge preserves diverged source history; conflicts remain', () => {
  const f = fixture(); const e = external(f);
  commit(e, 'remote', 'other'); git(e, 'push');
  const source = commit(f.feature, 'feature', 'feature');
  const result = publish(f); assert.equal(result.code, 0, result.error); assert.notEqual(result.candidate, source);
  assert.equal(git(f.feature, 'rev-parse', 'HEAD'), source);
  assert.equal(git(f.root, 'rev-list', '--parents', '-n', '1', result.candidate).split(' ').length, 3);
  const conflict = fixture(); const e2 = external(conflict);
  commit(e2, 'base', 'remote edit'); git(e2, 'push');
  const frozen = commit(conflict.feature, 'base', 'local edit');
  const failed = publish(conflict); assert.equal(failed.code, 1); assert.ok(fs.existsSync(path.join(failed.integration, '.git')));
  assert.equal(guard(failed.integration, ['status']).operation, true);
  assert.equal(git(conflict.feature, 'rev-parse', 'HEAD'), frozen); assert.equal(git(conflict.feature, 'status', '--porcelain'), '');
  assert.equal(remoteHead(conflict), git(e2, 'rev-parse', 'HEAD'));
});

test('verification file, HEAD, source, and operation changes block pushes', () => {
  const f = fixture(); const before = remoteHead(f); commit(f.feature, 'feature', 'feature');
  for (const verify of ['printf dirty > generated', 'git commit --allow-empty -m changed']) {
    const result = publish(f, verify); assert.equal(result.code, 1); assert.equal(remoteHead(f), before);
  }
  let result = publish(f, `printf dirty > ${quote(path.join(f.feature, 'source-dirty'))}`);
  assert.equal(result.code, 1); assert.equal(remoteHead(f), before); fs.unlinkSync(path.join(f.feature, 'source-dirty'));
  result = publish(f, `git -C ${quote(f.feature)} commit --allow-empty -m source-moved`);
  assert.equal(result.code, 1); assert.equal(remoteHead(f), before);
  const gitDir = git(f.feature, 'rev-parse', '--absolute-git-dir'); fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), git(f.feature, 'rev-parse', 'HEAD'));
  assert.equal(publish(f).code, 1); assert.equal(guard(f.feature, ['status']).operation, true);
});

test('distinct or multiple push/fetch URLs refuse before any remote write', () => {
  for (const kind of ['push-mismatch', 'multiple-push', 'multiple-fetch', 'push-rewrite']) {
    const f = fixture(); const source = commit(f.feature, 'feature', 'feature');
    git(f.feature, 'push', 'origin', `${source}:refs/heads/main`); // Candidate already lives on A.
    const other = path.join(f.dir, 'other.git'); git(f.dir, 'clone', '--bare', f.origin, other);
    git(other, 'update-ref', 'refs/heads/main', `${source}^`);
    const before = git(other, 'rev-parse', 'refs/heads/main');
    if (kind === 'push-mismatch') git(f.root, 'config', 'remote.origin.pushurl', other);
    if (kind === 'multiple-push') {
      git(f.root, 'config', '--add', 'remote.origin.pushurl', f.origin);
      git(f.root, 'config', '--add', 'remote.origin.pushurl', other);
    }
    if (kind === 'multiple-fetch') git(f.root, 'config', '--add', 'remote.origin.url', other);
    if (kind === 'push-rewrite') git(f.root, 'config', `url.${other}.pushInsteadOf`, f.origin);
    const result = publish(f); assert.equal(result.code, 1, kind); assert.match(result.error, /destination|rewrite/);
    assert.equal(git(other, 'rev-parse', 'refs/heads/main'), before);
    assert.equal(git(f.origin, 'rev-parse', 'refs/heads/main'), source);
    assert.equal(result.integration, undefined);
  }
});

test('effective insteadOf URLs work; verification config mutations block publication', () => {
  const f = fixture(); const source = commit(f.feature, 'feature', 'feature');
  git(f.root, 'config', `url.${f.origin}.insteadOf`, 'https://example.invalid/fixture.git');
  git(f.root, 'remote', 'set-url', 'origin', 'https://example.invalid/fixture.git');
  const success = publish(f); assert.equal(success.code, 0, success.error); assert.equal(success.candidate, source);
  for (const mutation of ['pushurl', 'url', 'rewrite']) {
    const g = fixture(); commit(g.feature, 'feature', 'feature');
    const before = remoteHead(g), other = path.join(g.dir, 'other.git'); git(g.dir, 'clone', '--bare', g.origin, other);
    const configArgs = mutation === 'rewrite' ? `url.${other}.pushInsteadOf ${quote(g.origin)}` : `remote.origin.${mutation} ${quote(other)}`;
    const result = publish(g, `git config ${configArgs}`);
    assert.equal(result.code, 1, mutation); assert.match(result.error, /destination|configuration changed/);
    assert.equal(git(g.origin, 'rev-parse', 'refs/heads/main'), before); assert.equal(git(other, 'rev-parse', 'refs/heads/main'), before);
    assert.ok(result.integration);
  }
});

test('external advance and rejected push never retry or change source', () => {
  const f = fixture(); const e = external(f); const source = commit(f.feature, 'feature', 'feature');
  commit(e, 'advance', 'advance');
  const result = publish(f, `git -C ${quote(e)} push origin main`);
  assert.equal(result.code, 1); assert.ok(result.integration); assert.equal(git(f.feature, 'rev-parse', 'HEAD'), source);
  assert.equal(remoteHead(f), git(e, 'rev-parse', 'HEAD'));
  const rejected = fixture(); const before = remoteHead(rejected); commit(rejected.feature, 'feature', 'feature');
  const hook = path.join(rejected.origin, 'hooks/pre-receive'); fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(publish(rejected).code, 1); assert.equal(remoteHead(rejected), before);
});

test('post-push offline outcome fails closed with retained integration', () => {
  const f = fixture(); commit(f.feature, 'feature', 'feature');
  const hook = path.join(f.origin, 'hooks/post-receive');
  fs.writeFileSync(hook, '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/missing\n', { mode: 0o755 });
  const before = git(f.root, 'rev-parse', 'HEAD');
  const result = publish(f); assert.equal(result.code, 1); assert.ok(result.integration);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
});

test('concurrent publishers and removal share one exclusive common-dir lock', async () => {
  const f = fixture(); commit(f.feature, 'feature', 'feature');
  const marker = path.join(f.dir, 'verify-started'), release = path.join(f.dir, 'verify-release');
  const command = `${quote(process.execPath)} -e ${quote(`require('fs').writeFileSync(${JSON.stringify(marker)},'ready');const end=Date.now()+12000;const t=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){clearInterval(t)}else if(Date.now()>end){process.exit(1)}},25)` )}`;
  const first = backgroundGuard(f.feature, ['publish', '--approved', '--verify', command]);
  await waitFor(marker);
  assert.match(publish(f).error, /busy/);
  assert.match(guard(f.feature, ['check-remove']).error, /busy/);
  assert.match(guard(f.root, ['refresh', '--approved']).error, /busy/);
  assert.equal(guard(f.feature, ['status']).code, 0);
  assert.match(guard(f.feature, ['unlock', '--approved']).error, /still alive/);
  fs.writeFileSync(release, 'go'); const result = await first.done; assert.equal(result.code, 0, result.error);
  assert.equal(fs.existsSync(path.join(f.root, '.git/repo-guard.lock')), false);
});

test('lock start identity is stable across timezone and locale changes', async () => {
  const f = fixture(); commit(f.feature, 'feature', 'feature');
  const marker = path.join(f.dir, 'utc-started'), release = path.join(f.dir, 'utc-release');
  const command = `${quote(process.execPath)} -e ${quote(`require('fs').writeFileSync(${JSON.stringify(marker)},'ready');const end=Date.now()+12000;const t=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(release)})){clearInterval(t)}else if(Date.now()>end){process.exit(1)}},25)` )}`;
  const first = backgroundGuard(f.feature, ['publish', '--approved', '--verify', command], { TZ: 'UTC', LC_ALL: 'C' });
  await waitFor(marker);
  const result = guard(f.feature, ['unlock', '--approved'], { TZ: 'Europe/Berlin', LC_ALL: 'de_DE.UTF-8' });
  assert.equal(result.code, 1); assert.match(result.error, /still alive/);
  const owner = JSON.parse(fs.readFileSync(path.join(f.root, '.git/repo-guard.lock/owner.json'), 'utf8'));
  assert.equal(owner.pid, first.child.pid);
  fs.writeFileSync(release, 'go'); assert.equal((await first.done).code, 0);
});

test('release and recovery share teardown claim and never leave an ownerless lock', async () => {
  const f = fixture(), ready = path.join(f.dir, 'owner-ready'), release = path.join(f.dir, 'release'), attempted = path.join(f.dir, 'release-attempted');
  const worker = spawn(process.execPath, ['-e', `const api=require(${JSON.stringify(cli)}),fs=require('fs');(async()=>{const s=await api.status(${JSON.stringify(f.feature)});const finish=await api.acquire(s);fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+15000;const t=setInterval(async()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);try{await finish();fs.writeFileSync(${JSON.stringify(attempted)},'released')}catch(e){fs.writeFileSync(${JSON.stringify(attempted)},e.code||e.message)}}else if(Date.now()>end)process.exit(1)},25)})()`], { cwd: f.root, env, stdio: 'ignore' });
  const deadline = setTimeout(() => worker.kill('SIGTERM'), 20000);
  const workerDone = new Promise(resolve => worker.on('close', resolve));
  await waitFor(ready);
  const bin = path.join(f.dir, 'race-bin'), marker = path.join(f.dir, 'recovery-claimed'), proceed = path.join(f.dir, 'recovery-proceed'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const out=cp.execFileSync('/bin/ps',process.argv.slice(2),{encoding:'utf8'});fs.writeFileSync(${JSON.stringify(marker)},'ready');const end=Date.now()+15000;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(t);process.stdout.write(out)}else if(Date.now()>end)process.exit(1)},25);\n`, { mode: 0o755 });
  const recovery = backgroundGuard(f.feature, ['unlock', '--approved'], { PATH: `${bin}:${env.PATH}` });
  await waitFor(marker); fs.writeFileSync(release, 'go'); await waitFor(attempted);
  assert.equal(fs.readFileSync(attempted, 'utf8'), 'EEXIST');
  const ownerFile = path.join(f.root, '.git/repo-guard.lock/owner.json');
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, worker.pid);
  fs.writeFileSync(proceed, 'go'); assert.match((await recovery.done).error, /still alive/);
  await workerDone; clearTimeout(deadline);
  assert.ok(fs.existsSync(ownerFile)); assert.equal(guard(f.feature, ['unlock', '--approved']).code, 0);
});

test('release failure is reported before success JSON', () => {
  const f = fixture(); commit(f.feature, 'feature', 'feature');
  const claim = path.join(f.root, '.git/repo-guard.lock/teardown');
  const result = publish(f, `printf blocked > ${quote(claim)}`);
  assert.equal(result.code, 1); assert.equal(result.allowed, false); assert.equal(result.published, undefined);
  assert.match(result.error, /EEXIST/);
  assert.ok(fs.existsSync(path.join(f.root, '.git/repo-guard.lock/owner.json')));
  fs.unlinkSync(claim); assert.equal(guard(f.feature, ['unlock', '--approved']).code, 0);
});

test('verification timeout kills owned group including grandchildren and releases lock', async () => {
  const f = fixture(); commit(f.feature, 'feature', 'feature'); const before = remoteHead(f);
  const pid = path.join(f.dir, 'grandchild.pid');
  const command = `${quote(process.execPath)} -e ${quote(`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pid)},String(c.pid));setInterval(()=>{},1000)` )}`;
  const result = publish(f, command, { REPO_GUARD_VERIFY_TIMEOUT_MS: '600' });
  assert.equal(result.code, 1); assert.match(result.error, /timed out/); assert.equal(remoteHead(f), before);
  const child = Number(fs.readFileSync(pid, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40; i++) { try { process.kill(child, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } throw e; } await new Promise(r => setTimeout(r, 25)); }
  assert.equal(alive, false, `Leaked grandchild ${child}`);
  assert.equal(fs.existsSync(path.join(f.root, '.git/repo-guard.lock')), false);
});

test('cancellation and parent death kill verification descendants', async () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const f = fixture(); commit(f.feature, 'feature', 'feature');
    const pid = path.join(f.dir, 'descendant.pid');
    const command = `${quote(process.execPath)} -e ${quote(`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pid)},String(c.pid));setInterval(()=>{},1000)` )}`;
    const running = backgroundGuard(f.feature, ['publish', '--approved', '--verify', command]);
    // SIGKILL has no JSON result, but the wrapper must still clean its process group.
    const outcome = running.done.catch(() => null);
    await waitFor(pid); const child = Number(fs.readFileSync(pid, 'utf8'));
    running.child.kill(signal); await outcome;
    let alive = true;
    for (let i = 0; i < 80; i++) { try { process.kill(child, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } throw e; } await new Promise(r => setTimeout(r, 25)); }
    assert.equal(alive, false, `Leaked descendant after ${signal}: ${child}`);
    const lock = path.join(f.root, '.git/repo-guard.lock');
    assert.equal(fs.existsSync(lock), signal === 'SIGKILL');
    if (signal === 'SIGKILL') assert.equal(guard(f.feature, ['unlock', '--approved']).code, 0);
  }
});

test('status deadline and parent death terminate local Git command grandchildren', async () => {
  const realGit = exec('/usr/bin/which', ['git'], sandbox);
  for (const parentDeath of [false, true]) {
    const f = fixture(), bin = path.join(f.dir, 'slow-bin'), pid = path.join(f.dir, 'status-child.pid'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node\nconst cp=require('child_process'),fs=require('fs');if(process.argv[2]==='rev-parse'){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pid)},String(child.pid));setInterval(()=>{},1000)}else{const r=cp.spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)}\n`, { mode: 0o755 });
    const start = Date.now(), running = backgroundGuard(f.feature, ['status'], { PATH: `${bin}:${env.PATH}` });
    const done = running.done.catch(() => null);
    await waitFor(pid); const child = Number(fs.readFileSync(pid, 'utf8'));
    if (parentDeath) running.child.kill('SIGKILL');
    const result = await done;
    if (!parentDeath) { assert.equal(result.code, 1); assert.match(result.error, /timed out/); assert.ok(Date.now() - start < 5500); }
    let alive = true;
    for (let i = 0; i < 100; i++) { try { process.kill(child, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } throw e; } await new Promise(r => setTimeout(r, 25)); }
    assert.equal(alive, false, `Leaked status descendant ${child}`);
  }
});

test('dead identity recovery is explicit; malformed lock is never stolen', () => {
  const f = fixture(); const dir = path.join(f.root, '.git/repo-guard.lock'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, start: 'different start identity', token: 'old' }));
  assert.match(guard(f.feature, ['check-remove']).error, /busy/);
  assert.equal(guard(f.feature, ['unlock']).code, 1);
  assert.equal(guard(f.feature, ['unlock', '--approved']).code, 0);
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), '{');
  assert.equal(guard(f.feature, ['unlock', '--approved']).code, 1); assert.ok(fs.existsSync(dir));
});

test('HelloFresh requires fresh exact feature ancestry or exact merged PR evidence', () => {
  const f = fixture({ hf: true }); const head = commit(f.feature, 'feature', 'feature');
  assert.equal(publish(f).code, 1); assert.equal(guard(f.feature, ['check-remove']).code, 1);
  git(f.feature, 'push', 'origin', 'feature');
  const published = guard(f.feature, ['check-remove']); assert.equal(published.code, 0, published.error); assert.equal(published.proof, 'feature-ancestry');
  git(f.root, 'merge', '--squash', 'feature'); git(f.root, 'commit', '-m', 'test: squash'); git(f.root, 'push');
  const merge = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'push', 'origin', '--delete', 'feature');
  const extra = ghProof(f, mergedData(head, merge));
  const result = guard(f.feature, ['check-remove'], extra); assert.equal(result.code, 0, result.error); assert.equal(result.proof, 'merged-pr');
  for (const data of [mergedData('0'.repeat(40), merge), mergedData(head, merge, { base: 'other' }), mergedData(head, merge, { repo: 'other/repo' }), mergedData(head, merge, { prRepo: 'other/repo' }), mergedData(head, merge, { state: 'OPEN' }), mergedData(head, head)]) {
    fs.writeFileSync(path.join(f.dir, 'proof.json'), JSON.stringify(data));
    assert.equal(guard(f.feature, ['check-remove'], extra).code, 1);
  }
  git(f.feature, 'checkout', '--detach');
  assert.equal(guard(f.feature, ['check-remove'], extra).code, 1);
});

test('cleanup removes only owned local fixtures and retained integrations', () => {
  for (const dir of integrations) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
  assert.equal(fs.existsSync(sandbox), false);
});
process.on('exit', () => {
  for (const dir of integrations) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
});
