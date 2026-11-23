#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../hellofresh/.local/bin/jira-worktree', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'test-jira-worktree-'));
const bin = join(home, 'bin');
const repos = join(home, 'projects/hellofresh');
const homeRepo = join(repos, 'hf-home');
const worktrees = join(home, 'worktrees/hellofresh');
const ticket = 'GLOA-123';

function mock(name, body) {
  writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
}

function choose(prefix) {
  return spawnSync('bash', [script, ticket], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, PICK: prefix, JIRA_TODAY_BRANCH_PREFIX: 'patch/' },
    encoding: 'utf8', timeout: 5000,
  });
}

try {
  mkdirSync(bin);
  for (const repo of ['hf-home', 'research', 'example-repo']) {
    mkdirSync(join(repos, repo, '.git'), { recursive: true });
  }
  mkdirSync(join(worktrees, 'patch-GLOA-123-fix', 'example-repo'), { recursive: true });
  mock('fzf', 'cat > "$HOME/choices"\ngrep -Fm1 -- "$PICK" "$HOME/choices"');
  mock('pbcopy', 'cat > "$HOME/copied"');

  const investigate = choose('investigate\thf-home');
  const choices = readFileSync(join(home, 'choices'), 'utf8').trimEnd().split('\n');
  assert.deepEqual(choices, [
    'reopen\tpatch/GLOA-123-fix\texample-repo', 'investigate\thf-home', 'new\texample-repo',
  ]);
  assert.equal(investigate.status, 0, investigate.stderr);
  assert(investigate.stdout.includes(homeRepo));
  const prompt = readFileSync(join(home, 'copied'), 'utf8');
  assert(prompt.includes(ticket));
  assert.match(prompt, /which repos define the relevant code or config/);
  assert.match(prompt, /which, if any, need changes/);
  assert.match(prompt, /Do not implement/);
  assert.throws(() => readFileSync(join(home, 'cop-args')), { code: 'ENOENT' });
  console.log('PASS Home handles investigation without creating a worktree or offering new legacy research');

  mock('cop', 'printf "%s\\n" "$@" > "$HOME/cop-args"');
  const reopen = choose('reopen\t');
  assert.equal(reopen.status, 0, reopen.stderr);
  assert.deepEqual(readFileSync(join(home, 'cop-args'), 'utf8').trimEnd().split('\n'), [
    'new', join(repos, 'example-repo'), '--branch', 'patch/GLOA-123-fix', '--yes',
  ]);
  assert.match(readFileSync(join(home, 'copied'), 'utf8'), /write an implementation plan/);
  console.log('PASS existing repo worktrees still reopen with the original branch and plan prompt');

  rmSync(homeRepo, { recursive: true });
  const absent = choose('investigate\t');
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /aborted/);
  assert.equal(readFileSync(join(home, 'choices'), 'utf8').includes('research'), false);
  assert.equal(readFileSync(join(home, 'choices'), 'utf8').includes('hf-home'), false);
  console.log('PASS missing Home does not fall back to the retired research repo');
} finally {
  rmSync(home, { recursive: true, force: true });
}
