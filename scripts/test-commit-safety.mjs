#!/usr/bin/env node
// All Git writes, synthetic dotenv files, and commits stay in disposable repos.
// Mocks make scanner behavior deterministic. No real credentials are read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = fs.readFileSync(path.join(source, '.githooks/pre-commit'));
const checker = path.join(source, 'scripts/check-commit-scope.mjs');
const gitExecutable = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const realScanner = spawnSync('/bin/sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim();
assert.ok(path.isAbsolute(gitExecutable), 'Git must be available');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, { scanner = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-safety-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Resolve macOS /var -> /private/var before comparing the scanner's cwd.
  const repo = path.join(fs.realpathSync(tmp), 'repo');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  // A private PATH and Git config prevent tests from using live hooks or scanners.
  for (const [name, executable] of [['git', gitExecutable], ['bash', '/bin/bash'], ['sed', '/usr/bin/sed'], ['grep', '/usr/bin/grep']]) {
    fs.symlinkSync(executable, path.join(bin, name));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('GITLEAKS_')));
  Object.assign(env, {
    HOME: tmp, XDG_CONFIG_HOME: tmp, PATH: bin, LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    BREW_LOG: path.join(tmp, 'brew.log'), SCAN_LOG: path.join(tmp, 'scan.log'),
    SCAN_PATHS: path.join(tmp, 'scan.paths'), SCAN_EXIT: '0',
  });
  const run = (command, args, cwd = repo, extraEnv = {}) => spawnSync(command, args, {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15_000,
  });
  const git = (...args) => {
    const result = run(gitExecutable, args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error}`);
    return result.stdout.trim();
  };
  const put = (name, content = 'fixture\n') => {
    const dest = path.join(repo, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  };
  const mock = (name, content) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${content}`, { mode: 0o755 });
  mock('brew', 'printf "called\\n" >> "$BREW_LOG"\nprintf "unexpected snapshot\\n" > brew/Brewfile\n');
  if (scanner) mock('gitleaks', 'printf "%s\\n" "$PWD" "$@" >> "$SCAN_LOG"\ngit diff --cached --name-only --no-renames -z -- > "$SCAN_PATHS" || exit 2\nexit "$SCAN_EXIT"\n');
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  put('example.env', 'FIXTURE_KEY=\n');
  put('brew/Brewfile', 'brew "fixture"\n');
  put('approved.txt', 'before\n');
  git('add', '--', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture baseline');
  put('.githooks/pre-commit', hook);
  fs.chmodSync(path.join(repo, '.githooks/pre-commit'), 0o755);
  git('config', 'core.hooksPath', '.githooks');
  put('nested/cwd/.keep');
  const baseline = () => ({
    example: hash(fs.readFileSync(path.join(repo, 'example.env'))),
    brew: hash(fs.readFileSync(path.join(repo, 'brew/Brewfile'))),
    index: hash(fs.readFileSync(path.join(repo, '.git/index'))),
  });
  const noMutation = before => {
    assert.deepEqual(baseline(), before, 'snapshot contents and index bytes stay unchanged');
    assert.equal(fs.existsSync(env.BREW_LOG), false, 'brew must never run');
  };
  const invoke = () => run('/bin/bash', [path.join(repo, '.githooks/pre-commit')], path.join(repo, 'nested/cwd'));
  const scope = (...args) => run(process.execPath, [checker, ...args], path.join(repo, 'nested/cwd'));
  const scanPaths = () => fs.readFileSync(env.SCAN_PATHS, 'utf8').split('\0').filter(Boolean);
  return { repo, env, run, git, put, baseline, noMutation, invoke, scope, scanPaths };
}

function stageChange(f, name = 'approved.txt', content = 'after\n') {
  f.put(name, content);
  f.git('add', '--', name);
}
function checkResult(result, succeeds) {
  assert.equal(result.status === 0, succeeds, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /--no-verify/);
}

test('hook uses root cwd and never regenerates or stages snapshots', t => {
  const f = fixture(t);
  // This is synthetic test data, not the source checkout's real .env.
  f.put('.env', 'SYNTHETIC_FIXTURE=not-a-credential\n');
  stageChange(f);
  const before = f.baseline();
  const result = f.invoke();
  checkResult(result, true);
  f.noMutation(before);
  assert.deepEqual(fs.readFileSync(f.env.SCAN_LOG, 'utf8').trim().split('\n'), [f.repo, 'protect', '--staged', '--redact', '--no-banner']);
});

test('missing scanner fails closed without modifying snapshots or index', t => {
  const f = fixture(t, { scanner: false });
  stageChange(f);
  const before = f.baseline();
  const result = f.invoke();
  checkResult(result, false);
  assert.match(result.stderr, /gitleaks.*(install|Install)|(?:install|Install).*gitleaks/);
  f.noMutation(before);
});

for (const exitCode of ['1', '2', '127']) {
  test(`scanner exit ${exitCode} fails closed without mutation`, t => {
    const f = fixture(t);
    f.env.SCAN_EXIT = exitCode;
    stageChange(f);
    const before = f.baseline();
    checkResult(f.invoke(), false);
    f.noMutation(before);
  });
}

for (const name of ['.env', '.env.local', '.env.production', '.env.example.local', 'nested/.env', 'nested/.env.private', 'space dir\nmore/.env.secret']) {
  test(`blocks real dotenv filename ${JSON.stringify(name)}`, t => {
    const f = fixture(t);
    stageChange(f, name, 'SYNTHETIC_FIXTURE=not-a-credential\n');
    const before = f.baseline();
    checkResult(f.invoke(), false);
    assert.equal(fs.existsSync(f.env.SCAN_LOG), false, 'filename gate stops before scanning');
    f.noMutation(before);
  });
}

for (const name of ['.env.example', 'nested/.env.sample']) {
  test(`template ${name} still requires a successful scan`, t => {
    const f = fixture(t);
    stageChange(f, name, 'FIXTURE_KEY=\n');
    const before = f.baseline();
    checkResult(f.invoke(), true);
    assert.deepEqual(f.scanPaths(), [name]);
    f.env.SCAN_EXIT = '1';
    checkResult(f.invoke(), false);
    f.noMutation(before);
  });
}

test('NUL-delimited staged names preserve spaces, newlines, and option-like names', t => {
  const f = fixture(t);
  const names = ['file with spaces.txt', 'nested/line\nbreak.txt', '-option.txt'];
  for (const name of names) stageChange(f, name);
  const before = f.baseline();
  checkResult(f.invoke(), true);
  assert.deepEqual(new Set(f.scanPaths()), new Set(names));
  f.noMutation(before);
});

for (const [from, to] of [['approved.txt', 'nested/.env.local'], ['nested/.env.old', 'safe.txt']]) {
  test(`rename checks both paths: ${JSON.stringify(from)} to ${JSON.stringify(to)}`, t => {
    const f = fixture(t);
    if (from !== 'approved.txt') {
      stageChange(f, from);
      f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic legacy dotenv');
    }
    fs.mkdirSync(path.dirname(path.join(f.repo, to)), { recursive: true });
    f.git('mv', '--', from, to);
    const before = f.baseline();
    checkResult(f.invoke(), false);
    f.noMutation(before);
  });
}

test('deleting a tracked dotenv file is also blocked by the filename gate', t => {
  const f = fixture(t);
  stageChange(f, '.env', 'SYNTHETIC_FIXTURE=not-a-credential\n');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic legacy dotenv');
  f.git('rm', '--', '.env');
  const before = f.baseline();
  checkResult(f.invoke(), false);
  assert.equal(fs.existsSync(f.env.SCAN_LOG), false);
  f.noMutation(before);
});

test('installed gitleaks scans safe staged fixtures without snapshot or index changes', {
  skip: !path.isAbsolute(realScanner) && 'gitleaks is not installed; mocked fail-closed behavior remains tested',
}, t => {
  const f = fixture(t, { scanner: false });
  fs.symlinkSync(realScanner, path.join(f.env.PATH, 'gitleaks'));
  const version = f.run(realScanner, ['version']);
  checkResult(version, true);
  t.diagnostic(`Installed gitleaks ${version.stdout.trim()}`);
  stageChange(f, '.env.example', 'FIXTURE_KEY=\n');
  const before = f.baseline();
  const result = f.invoke();
  checkResult(result, true);
  assert.match(`${result.stdout}${result.stderr}`, /no leaks found/i);
  f.noMutation(before);
  t.diagnostic('Real gitleaks staged scan passed; snapshot hashes and index bytes unchanged.');
});

test('unexpected git diff errors fail closed without mutation', t => {
  const f = fixture(t);
  stageChange(f);
  const before = f.baseline();
  fs.unlinkSync(path.join(f.env.PATH, 'git'));
  fs.writeFileSync(path.join(f.env.PATH, 'git'), `#!/bin/sh\ncase "$1" in\n  rev-parse) exec "${gitExecutable}" "$@" ;;\n  *) exit 42 ;;\nesac\n`, { mode: 0o755 });
  checkResult(f.invoke(), false);
  f.noMutation(before);
});

test('actual commit --only preserves unrelated staged files and checks the commit itself', t => {
  const f = fixture(t);
  stageChange(f, 'unrelated.txt', 'already staged\n');
  const unrelatedBefore = f.git('ls-files', '--stage', '--', 'unrelated.txt');
  f.put('approved.txt', 'approved change\n');
  const before = f.baseline();
  checkResult(f.run(gitExecutable, ['commit', '--only', '-qm', 'approved fixture', '--', 'approved.txt']), true);
  assert.equal(f.git('ls-files', '--stage', '--', 'unrelated.txt'), unrelatedBefore);
  assert.equal(f.git('diff', '--cached', '--name-only'), 'unrelated.txt');
  assert.deepEqual(f.scanPaths(), ['approved.txt'], 'scanner sees the temporary commit index, not unrelated staged work');
  const after = f.baseline();
  assert.equal(after.example, before.example);
  assert.equal(after.brew, before.brew);
  assert.equal(fs.existsSync(f.env.BREW_LOG), false);
  checkResult(f.scope('HEAD', 'approved.txt'), true);
  // Deliberately include an extra file in a disposable fixture commit.
  stageChange(f, 'approved.txt', 'second change\n');
  f.git('commit', '-qm', 'extra actual path fixture');
  const result = f.scope('HEAD', 'approved.txt');
  checkResult(result, false);
  assert.match(result.stderr, /unapproved.*unrelated\.txt/i);
});

test('scope checker accepts exact paths and prints the resolved SHA without mutation', t => {
  const f = fixture(t);
  stageChange(f);
  f.git('commit', '-qm', 'approved fixture');
  const before = f.baseline();
  const sha = f.git('rev-parse', 'HEAD');
  const result = f.scope('HEAD', 'approved.txt');
  checkResult(result, true);
  assert.ok(result.stdout.includes(sha));
  assert.match(result.stdout, /PASS/);
  f.noMutation(before);
  const missing = f.scope('HEAD', 'approved.txt', 'missing.txt');
  checkResult(missing, false);
  assert.match(missing.stderr, /missing.*missing\.txt/i);
  assert.ok(missing.stdout.includes(sha));
  f.noMutation(before);
});

test('scope checker handles root commits, deletions, and renamed odd paths', t => {
  const f = fixture(t);
  checkResult(f.scope('HEAD', 'example.env', 'brew/Brewfile', 'approved.txt'), true);
  const to = 'nested/renamed with\nnewline.txt';
  f.git('mv', '--', 'approved.txt', to);
  f.git('rm', '--', 'example.env');
  f.git('commit', '-qm', 'rename and deletion fixture');
  checkResult(f.scope('HEAD', 'approved.txt', to, 'example.env'), true);
  checkResult(f.scope('HEAD', to, 'example.env'), false);
});

for (const args of [[], ['HEAD'], ['', 'approved.txt'], ['--all', 'approved.txt'], ['HEAD\n', 'approved.txt'], ['HEAD..HEAD', 'approved.txt'], ['does-not-exist', 'approved.txt'], ['HEAD', ''], ['HEAD', '/absolute'], ['HEAD', '../escape'], ['HEAD', 'nested/../escape'], ['HEAD', './approved.txt'], ['HEAD', 'nested//file'], ['HEAD', 'nested/'], ['HEAD', 'C:\\absolute'], ['HEAD', 'approved.txt', 'approved.txt']]) {
  test(`scope checker rejects invalid input ${JSON.stringify(args)}`, t => {
    const f = fixture(t);
    const before = f.baseline();
    checkResult(f.scope(...args), false);
    f.noMutation(before);
  });
}

test('scope checker rejects ambiguous revision names even when Git prefers a branch', t => {
  const f = fixture(t);
  f.git('branch', 'collision');
  f.git('tag', 'collision');
  f.git('config', 'core.warnAmbiguousRefs', 'false');
  const result = f.scope('collision', 'approved.txt');
  checkResult(result, false);
  assert.match(result.stderr, /ambiguous/i);
});

test('scope checker ignores replacement objects and checks the actual commit', t => {
  const f = fixture(t);
  stageChange(f);
  f.git('commit', '-qm', 'approved fixture');
  const approved = f.git('rev-parse', 'HEAD');
  stageChange(f, 'extra.txt');
  f.git('commit', '-qm', 'extra path fixture');
  f.git('replace', 'HEAD', approved);
  const result = f.scope('HEAD', 'approved.txt');
  checkResult(result, false);
  assert.match(result.stderr, /unapproved.*extra\.txt/i);
});

test('scope checker fails closed when a shallow commit parent is missing', t => {
  const f = fixture(t);
  stageChange(f);
  f.git('commit', '-qm', 'shallow fixture');
  const clone = path.join(path.dirname(f.repo), 'shallow');
  f.git('clone', '-q', '--depth=1', `file://${f.repo}`, clone);
  const result = f.run(process.execPath, [checker, 'HEAD', 'approved.txt'], clone);
  checkResult(result, false);
  assert.match(result.stderr, /Git query failed/i);
});

test('scope checker rejects merge commits, including at a shallow boundary', t => {
  const f = fixture(t);
  const initialBranch = f.git('symbolic-ref', '--short', 'HEAD');
  f.git('checkout', '-qb', 'side');
  stageChange(f, 'side.txt');
  f.git('commit', '-qm', 'side fixture');
  f.git('checkout', '-q', initialBranch);
  stageChange(f, 'main.txt');
  f.git('commit', '-qm', 'main fixture');
  f.git('-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '-qm', 'merge fixture', 'side');
  const before = f.baseline();
  const result = f.scope('HEAD', 'side.txt');
  checkResult(result, false);
  assert.match(result.stderr, /merge/i);
  f.noMutation(before);
  f.put('.git/shallow', `${f.git('rev-parse', 'HEAD')}\n`);
  const shallowResult = f.scope('HEAD', 'side.txt');
  checkResult(shallowResult, false);
  assert.match(shallowResult.stderr, /merge/i);
  f.noMutation(before);
});
