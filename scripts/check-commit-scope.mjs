#!/usr/bin/env node
// Read-only publication check. This verifies a commit's exact path set, not
// permission to commit or publish. It never stages files or changes Git state.
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

const usage = 'Usage: node scripts/check-commit-scope.mjs REVISION approved/path ...';
const [revision, ...paths] = process.argv.slice(2);
const quote = value => JSON.stringify(value);

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Git query failed: ${result.error?.message || result.stderr?.toString().trim() || `exit ${result.status}`}`);
  }
  // Invalid UTF-8 cannot be matched reliably to CLI arguments. Stop safely.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return { stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

try {
  if (!revision || paths.length === 0) throw new Error(usage);
  // No ranges, option injection, whitespace, or NULs. Git resolves all other
  // revision syntax to one existing commit, with ambiguity warnings forced on.
  if (/^[\-]|[\s\0]|\.\./u.test(revision)) throw new Error(`Invalid single revision: ${quote(revision)}`);
  const approved = new Set();
  for (const file of paths) {
    // Require exact repo-relative paths, not patterns or normalized aliases.
    // Spaces and newlines are valid Git filename bytes and remain intact.
    if (!file || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)
        || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid approved path: ${quote(file)}`);
    }
    if (approved.has(file)) throw new Error(`Duplicate approved path: ${quote(file)}`);
    approved.add(file);
  }

  const resolved = git(['-c', 'core.warnAmbiguousRefs=true', 'rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  // rev-parse can exit zero for a branch/tag collision. Do not accept warnings.
  if (resolved.stderr.trim()) throw new Error(`Revision resolution is not unambiguous: ${resolved.stderr.trim()}`);
  const sha = resolved.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error('Git did not resolve a single commit SHA.');
  console.log(`Commit: ${sha}`);

  // Read real object parents, not traversal history. A shallow boundary must
  // not make a merge look like a root commit or hide the actual diff's parent.
  const header = git(['cat-file', '-p', sha]).stdout.split('\n\n', 1)[0];
  const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (parents.some(parent => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent))) throw new Error('Cannot verify commit ancestry.');
  if (parents.length > 1) throw new Error('Merge commits are not supported. Check a single-parent commit instead.');

  // --root includes an initial commit. An explicit parent fails closed if its
  // object is missing. --no-renames requires BOTH sides of a rename in approval.
  const output = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames',
    '--no-ext-diff', '--no-textconv', '-r', '-z', ...parents, sha, '--']).stdout;
  if (output && !output.endsWith('\0')) throw new Error('Git returned malformed path records.');
  const actual = new Set(output ? output.slice(0, -1).split('\0') : []);
  if (actual.has('')) throw new Error('Git returned an empty diff path.');
  const unapproved = [...actual].filter(file => !approved.has(file)).sort();
  const missing = [...approved].filter(file => !actual.has(file)).sort();
  if (unapproved.length || missing.length) {
    for (const file of unapproved) console.error(`Unapproved actual path: ${quote(file)}`);
    for (const file of missing) console.error(`Missing expected path: ${quote(file)}`);
    throw new Error('Actual commit paths do not exactly match the approved set.');
  }
  console.log(`PASS: ${actual.size} actual commit path(s) exactly match the approved set. No permission is granted.`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
