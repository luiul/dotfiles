#!/usr/bin/env bun
/** Native discovery with real Worktrunk fixtures. Run: bun scripts/test-scoped-agent-context.ts */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidate, installed, makeFixture, put, run, sdk } from './test-scoped-agent-context-live.mjs';

const { loadProjectContextFiles } = await sdk();
const { resolveCheckout, scopeContext, isLegacyOwnerLink, default: extension } = await import(pathToFileURL(candidate).href);
const original = readFileSync(candidate, 'utf8'), f = makeFixture(), checks: string[] = [];
const check = (name: string, fn: () => void) => { fn(); checks.push(name); console.log(`PASS ${name}`); };
const native = (cwd: string) => loadProjectContextFiles({ cwd, agentDir: f.env.PI_CODING_AGENT_DIR });
const scoped = (cwd: string, files = native(cwd)) => scopeContext(files, resolveCheckout(cwd), cwd, f.env.PI_CODING_AGENT_DIR, f.home);
const marks = (files: Array<{ content: string }>) => files.map(x => x.content.trim());
// Native files above the temp root may exist on a contributor's machine. Keep assertions fixture-local.
const fixtureMarks = (files: Array<{ path: string; content: string }>) => marks(files.filter(x => x.path.startsWith(f.root + '/')));
const saved = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'PI_CODING_AGENT_DIR'].map(k => [k, process.env[k]]));
process.env.PI_CODING_AGENT_DIR = f.env.PI_CODING_AGENT_DIR;
try {
  check('real native discovery reproduces the legacy owner link before scoping', () => {
    const files = native(f.p.linked);
    assert(files.some(x => x.path === join(f.owner, 'AGENTS.md') && x.content === 'SC_HF\n'));
    assert(!marks(files).includes('SC_PERSONAL'));
  });
  check('linked and primary cwd resolve by Git identity, including nested linked cwd', () => {
    assert.deepEqual(resolveCheckout(join(f.p.linked, 'nested/deep')), { root: f.p.linked, primary: f.p.primary });
    assert.deepEqual(resolveCheckout(join(f.p.primary, 'nested')), { root: f.p.primary, primary: f.p.primary });
    assert.equal(resolveCheckout(f.owner), undefined);
  });
  check('same owner and same branch never confuse distinct repository roots', () => {
    assert.deepEqual(resolveCheckout(f.hf.linked), { root: f.hf.linked, primary: f.hf.primary });
    assert.deepEqual(resolveCheckout(f.other.linked), { root: f.other.linked, primary: f.other.primary });
    assert.deepEqual(fixtureMarks(scoped(f.other.linked)), ['SC_GLOBAL','SC_ROOT','SC_HOME','SC_WORKTREES','SC_BRANCH','SC_PROJECTS','SC_PERSONAL','SC_REPO_Q']);
  });
  check('complete primary ancestor ordering precedes local nested instructions and override', () => {
    assert.deepEqual(fixtureMarks(scoped(join(f.p.linked, 'nested/deep'))), ['SC_GLOBAL','SC_ROOT','SC_HOME','SC_WORKTREES','SC_BRANCH','SC_PROJECTS','SC_PERSONAL','SC_DOMAIN','SC_REPO_P','SC_REPO_P_NESTED','SC_REPO_P_OVERRIDE']);
    assert.deepEqual(fixtureMarks(scoped(join(f.hf.linked, 'nested/deep'))), ['SC_GLOBAL','SC_ROOT','SC_HOME','SC_WORKTREES','SC_BRANCH','SC_PROJECTS','SC_HF','SC_PLATFORM','SC_REPO_HF','SC_REPO_HF_NESTED','SC_REPO_HF_OVERRIDE']);
  });
  check('primary checkout preserves native discovery unchanged', () => { assert.deepEqual(scoped(f.p.primary), native(f.p.primary)); });
  check('repeated scoping is idempotent and does not mutate incoming native files', () => {
    const files = native(f.p.linked), snapshot = structuredClone(files), first = scoped(f.p.linked, files);
    assert.deepEqual(files, snapshot); assert.deepEqual(scoped(f.p.linked, first), first);
  });
  check('refreshed canonical ancestor instructions are read without a session restart', () => {
    const path = join(dirname(f.p.primary), 'CLAUDE.md'), old = readFileSync(path, 'utf8');
    try { writeFileSync(path, 'SC_DOMAIN_NEW\n'); assert(fixtureMarks(scoped(f.p.linked)).includes('SC_DOMAIN_NEW')); }
    finally { writeFileSync(path, old); }
  });
  check('AGENTS.override.md takes precedence over AGENTS.md and CLAUDE.md only at its own directory', () => {
    const files = native(join(f.p.linked, 'nested/deep'));
    assert(marks(files).includes('SC_REPO_P_OVERRIDE')); assert(!marks(files).includes('SC_REPO_P_SHADOWED'));
    assert(marks(files).includes('SC_REPO_P_NESTED')); assert(marks(files).includes('SC_GLOBAL'));
  });
  check('CLAUDE.md remains a filename fallback, no retired CLI is used', () => {
    assert(scoped(f.p.linked).some(x => x.path === join(dirname(f.p.primary), 'CLAUDE.md')));
  });
  check('only exact known legacy owner link targets are filtered, never deleted', () => {
    const link = join(f.owner, 'AGENTS.md'); assert(isLegacyOwnerLink(link, f.p.linked, f.home));
    assert(existsSync(link)); assert(!scoped(f.p.linked).some(x => x.path === link)); assert(existsSync(link));
    unlinkSync(link); f.instructions(join(f.home, 'dotfiles/hellofresh/projects/hellofresh'), 'SC_HF_STOW');
    symlinkSync(join(f.home, 'dotfiles/hellofresh/projects/hellofresh/AGENTS.md'), link);
    assert(isLegacyOwnerLink(link, f.p.linked, f.home)); assert(!scoped(f.p.linked).some(x => x.path === link));
    unlinkSync(link); symlinkSync(join(f.home, 'projects/hellofresh/AGENTS.md'), link);
    const legacyClaude = join(f.owner, 'CLAUDE.md'); f.instructions(join(f.home, 'projects/hellofresh'), 'SC_HF_CLAUDE', 'CLAUDE.md');
    symlinkSync('../' + '../projects/hellofresh/CLAUDE.md', legacyClaude);
    try { assert(isLegacyOwnerLink(legacyClaude, undefined, f.home)); }
    finally { unlinkSync(legacyClaude); }
  });
  check('unknown owner regular file and symlink are preserved', () => {
    const link = join(f.owner, 'AGENTS.md'); unlinkSync(link); f.instructions(f.owner, 'SC_UNKNOWN_REGULAR');
    assert(!isLegacyOwnerLink(link, f.p.linked, f.home)); assert(fixtureMarks(scoped(f.p.linked)).includes('SC_UNKNOWN_REGULAR'));
    unlinkSync(link); f.instructions(join(f.home, 'custom'), 'SC_UNKNOWN_LINK'); symlinkSync(join(f.home, 'custom/AGENTS.md'), link);
    assert(!isLegacyOwnerLink(link, f.p.linked, f.home)); assert(fixtureMarks(scoped(f.p.linked)).includes('SC_UNKNOWN_LINK'));
    unlinkSync(link); symlinkSync(join(f.home, 'projects/hellofresh/AGENTS.md'), link);
  });
  check('local repo instruction symlink remains local and follows inherited canonical context', () => {
    const path = join(f.p.linked, 'AGENTS.md'), old = readFileSync(path, 'utf8'); unlinkSync(path);
    symlinkSync(join(f.p.primary, 'AGENTS.md'), path);
    try {
      const files = scoped(join(f.p.linked, 'nested/deep'));
      const index = files.findIndex(x => x.path === path); assert(index >= 0);
      assert(files.findIndex(x => x.content === 'SC_DOMAIN\n') < index);
      assert.equal(files.filter(x => x.content === 'SC_REPO_P\n').length, 1);
      assert(!isLegacyOwnerLink(path, f.p.linked, f.home));
    } finally { unlinkSync(path); writeFileSync(path, old); }
  });
  check('Git environment overrides cannot redirect linked checkout identity', () => {
    process.env.GIT_DIR = join(f.other.primary, '.git'); process.env.GIT_WORK_TREE = f.other.primary;
    process.env.GIT_COMMON_DIR = join(f.other.primary, '.git'); process.env.GIT_INDEX_FILE = join(f.root, 'foreign-index'); process.env.GIT_PREFIX = 'foreign/';
    try { assert.deepEqual(resolveCheckout(join(f.p.linked, 'nested')), { root: f.p.linked, primary: f.p.primary }); }
    finally { for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_PREFIX']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  });
  check('empty effective context honors SDK and native CLI opt-outs', () => {
    const handlers = new Map<string, Function>(); extension({ on: (name: string, fn: Function) => handlers.set(name, fn) });
    const handler = handlers.get('before_agent_start')!, ctx = { cwd: f.p.linked, abort: () => { throw Error('Unexpected abort'); } };
    // Native discovery supplies an empty list for actual CLI flags. Raw argv is not authoritative.
    for (const source of ['SDK', '--no-context-files', '-nc']) {
      const files = [], event = { systemPromptOptions: { contextFiles: files } };
      handler(event, ctx); assert.equal(event.systemPromptOptions.contextFiles, files, source);
    }
  });
  check('literal prompt flags after -- do not bypass scoping', () => {
    const handlers = new Map<string, Function>(); extension({ on: (name: string, fn: Function) => handlers.set(name, fn) });
    const oldArgv = process.argv;
    try {
      for (const literal of ['-nc', '--no-context-files']) {
        process.argv = [...oldArgv, '--', literal];
        const event = { systemPromptOptions: { contextFiles: native(f.p.linked) } };
        handlers.get('before_agent_start')!(event, { cwd: f.p.linked, abort: () => { throw Error('Unexpected abort'); } });
        assert(fixtureMarks(event.systemPromptOptions.contextFiles).includes('SC_DOMAIN'));
      }
    } finally { process.argv = oldArgv; }
  });
  check('same session revalidates relocated primary after repair, without recurring Git calls', () => {
    const handlers = new Map<string, Function>(); extension({ on: (name: string, fn: Function) => handlers.set(name, fn) });
    const ctx = { cwd: f.p.linked, abort: () => { throw Error('Unexpected abort'); } }, handler = handlers.get('before_agent_start')!;
    const incoming = native(f.p.linked), calls = join(f.root, 'identity-git-calls'), bin = join(f.root, 'counting-bin');
    const realGit = run('which', ['git'], f.env), oldPath = process.env.PATH;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    put(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\nexec ${quote(realGit)} "$@"\n`);
    run('chmod', ['+x', join(bin, 'git')], f.env);
    const count = () => readFileSync(calls, 'utf8').trim().split('\n').length;
    const turn = () => { const event = { systemPromptOptions: { contextFiles: structuredClone(incoming) } }; handler(event, ctx); return fixtureMarks(event.systemPromptOptions.contextFiles); };
    const destination = join(f.home, 'projects/relocated/tool');
    f.instructions(dirname(destination), 'SC_RELOCATED'); let moved = false;
    try {
      process.env.PATH = `${bin}:${oldPath}`;
      assert(turn().includes('SC_DOMAIN')); const initialCalls = count(); assert(initialCalls > 0);
      turn(); assert.equal(count(), initialCalls, 'Stable identity must not call Git again');
      const ordinaryLock = join(f.p.primary, '.git/index.lock');
      writeFileSync(ordinaryLock, 'fixture lock');
      try { turn(); assert.equal(count(), initialCalls, 'Routine Git directory changes must not invalidate topology'); }
      finally { unlinkSync(ordinaryLock); }
      turn(); assert.equal(count(), initialCalls, 'Lock cleanup must not revalidate identity');
      renameSync(f.p.primary, destination); moved = true; f.git(destination, 'worktree', 'repair', f.p.linked);
      const relocated = turn(); assert(relocated.includes('SC_RELOCATED')); assert(!relocated.includes('SC_DOMAIN')); assert(!relocated.includes('SC_PERSONAL'));
      const repairedCalls = count(); assert(repairedCalls > initialCalls, 'Repair must invalidate the cached identity');
      turn(); assert.equal(count(), repairedCalls, 'Repaired stable identity must remain cached');
    } finally {
      process.env.PATH = oldPath;
      if (moved) { mkdirSync(dirname(f.p.primary), { recursive: true }); renameSync(destination, f.p.primary); f.git(f.p.primary, 'worktree', 'repair', f.p.linked); }
    }
  });
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  f.cleanup(); assert.equal(readFileSync(candidate, 'utf8'), original);
}
check('private Worktrunk checkouts removed and candidate untouched', () => { assert(!existsSync(f.root)); });
console.log(`Checks: ${checks.length} passed (Pi ${JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version})`);
