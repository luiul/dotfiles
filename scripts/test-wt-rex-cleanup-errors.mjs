import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'zsh/.zsh_config/funcs_rex.zsh'), 'utf8');
const script = source.match(/do -s "\$REX_SESSION" --args "\$args" -e '([\s\S]*?)'\n/)[1];
const supervisor = source.match(/command \/usr\/bin\/perl -e '([\s\S]*?)' --/)[1];
const fixture = await RexTestDriver.start({ deadlineMs: 90000 });
try {
  const host = fixture.create({ command: ['/bin/sleep', '60'], cwd: fixture.root, env: {}, columns: 80, rows: 24 });
  const { binary, endpoint } = fixture.manifest();
  const invoke = (code, timeout = '2s') => spawnSync('/usr/bin/perl', [
    '-e', supervisor, '--', binary,
    '--autostart=false', '--timeout', timeout, '-S', endpoint,
    'do', '-s', host.sessionId, '--args', JSON.stringify({ session: host.sessionId, block: host.blockId }), '-e', code,
  ], { encoding: 'utf8', timeout: 10000 });
  // Mock only server replies. Run the actual source Lua and real CLI stop/timeout behavior.
  for (const failAt of ['block.close', 'session.view', 'session.list_blocks', 'session.destroy']) {
    const prefix = `rex.call = function(method, args)
      if method == ${JSON.stringify(failAt)} then return nil, "fixture API failure" end
      if method == "session.view" then return {session_id=rex.args.session, windows={}} end
      if method == "session.list_blocks" then return {blocks={}} end
      return {}
    end\n`;
    const result = invoke(prefix + script);
    assert.equal(result.status, 1, `${failAt}: ${result.stderr}`);
    console.log(`PASS: ${failAt} failure returns nonzero`);
  }
  const started = Date.now();
  const timed = spawnSync('/usr/bin/perl', [
    '-e', supervisor.replace('alarm 10;', 'alarm 1;'), '--', binary,
    '--autostart=false', '--timeout', '1s', '-S', endpoint,
    'do', '-s', host.sessionId, '-e', 'rex.sleep(10)',
  ], { encoding: 'utf8', timeout: 8000 });
  assert.equal(timed.status, 124, 'Sleeping cleanup must hit its owned-child deadline');
  assert.equal(timed.error, undefined, 'Outer timeout must not supply the client deadline');
  assert.ok(Date.now() - started < 7000, 'OS alarm did not bound the cleanup client');
  console.log('PASS: the owned-child deadline ends a sleeping Rex client without an outer kill');
  // Dispatch ALRM just after normal wait reaps the child. Signaling its PID is forbidden.
  const raced = supervisor
    .replace('kill "TERM", $pid;', 'die "Signaled a reaped child";')
    .replace('waitpid($pid, 0);\n      alarm 0;', 'waitpid($pid, 0);\n      $SIG{ALRM}->();\n      alarm 0;');
  const exited = spawnSync('/usr/bin/perl', ['-e', raced, '--', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(exited.status, 124, exited.stderr);
  assert.ok(!exited.stderr.includes('Signaled a reaped child'));
  console.log('PASS: an alarm after reaping cannot signal the former child PID');
} finally {
  await fixture.stop();
}
