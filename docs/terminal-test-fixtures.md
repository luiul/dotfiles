# Terminal test fixtures

TLDR: The test backend uses a separate Rex server, not the desktop server. Keep tmux installed until this source candidate is reviewed, published and verified in the live checkout.

## Ownership

`scripts/rex-test-driver.mjs` starts a foreground server on a short private Unix socket. The fixture root has mode `0700`, and the socket has mode `0600`. Its state and Lua config are separate. Session restoration is disabled. Every bootstrap command specifies the exact endpoint and disables autostart.

The server, controller, and registered exec targets belong to the fixture. The desktop app is never connected to this endpoint. Do not add the endpoint to Rex hosts or call app actions from the fixture.

The test driver retains full session and block IDs. Names are labels, not identity. The private Lua controller checks the server instance on its existing connection before each operation.

## Terminal behavior

Initial dimensions are part of the terminal creation options. Runtime resize claims ownership and changes dimensions on one connection. Tests check the observed dimensions and redraw, not only a successful request.

On macOS, Rex can wrap a command in `login`. The driver records the exec target PID inside its wrapper and registers it before allowing the target to run. Do not use the outer `process.child` PID as the Pi host PID.

Plain Rex formatting omits blank trailing rows. Current-screen capture therefore uses the row-preserving VT redraw, selects the viewport, then removes style sequences for plain assertions. History capture is a separate operation. Styled assertions use VT or HTML, not original-write byte identity. Original ANSI logs remain separate artifacts when a test measures writes.

## Cleanup

A startup guard owns the server and controller child handles before their identities are published. Supervisor death before registration closes its liveness pipe and triggers bounded teardown. Registration handoff must complete before the guard releases ownership.

The supervisor handles normal stop, owner death, and deadlines after handoff. `reap-rex-tests.mjs` is the explicit registration backstop. It does not discover or classify arbitrary Rex processes.

The backstop requires an expired deadline and absent owner and supervisor. It checks registered process identities, root and socket identities, and metadata again before signaling. Successful TERM allows later KILL only after a recorded grace period. Failed TERM does not authorize KILL. Dry-run audit sends no signals and changes no files. Operational failures return a failure status; a live owner or an unexpired deadline is a normal skip.

Registered detached test children must publish their identity before useful work begins. Neither terminal hangup nor these checks contain arbitrary unregistered self-detaching processes. Do not claim they do.

macOS does not provide a pidfd for atomic instance-bound signaling through this interface. PID and start-time checks reduce reuse risk but are not atomic with a signal. Ambiguous identities preserve the task and report a blocked cleanup. Simultaneous forced termination of both the startup guard and supervisor before registration is outside the proof.

Successful teardown verifies server, controller, registered targets, and socket absence. Registry completion is separate from removal of the fixture root. Failed cleanup retains evidence and fails the test.

## Small TUI checks

Import the maintained driver from the intended source checkout. Do not call `session.create` on the desktop endpoint. Keep `stop()` in a `finally` block. A failed stop must fail the test and preserve its evidence.

```js
import { RexTestDriver } from './scripts/rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: 60000 });
try {
  const host = driver.create({
    command: ['/absolute/path/to/app'],
    cwd: '/absolute/path/to/fixture',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    columns: 120, rows: 40,
  });
  driver.key(host, 'ctrl+o');
  console.log(driver.capture(host));
  driver.resize(host, 40, 24);
  console.log(driver.capture(host, { history: true }));
} finally {
  await driver.stop();
}
```

Literal strings use `driver.text`. Named chords use `driver.key`. Commands and fixture environments are explicit; the driver does not inherit credentials. Start with a short deadline and enough time for startup and cleanup. The desktop Rex app is not needed.

## Python bridge

`scripts/rex_test_driver.py` uses the same Node driver through `rex-test-service.mjs`. The service owns the fixture lifetime. EOF, cancellation, and explicit stop request teardown. Python must not launch a new service for each terminal operation, because that would lose the owner lifetime.

## Running checks

Run Node harnesses with native Node, not Bun. Tests that intentionally use Bun say so in their header. Use `uv run` for Python harnesses.

```sh
node scripts/test-rex-driver-safety.mjs
node scripts/test-rex-test-driver.mjs
node scripts/test-rex-viewport.mjs
node scripts/test-rex-lifecycle.mjs
node scripts/test-rex-reaper-live.mjs
node scripts/test-reap-rex-tests.mjs
node scripts/test-git-prompt-handshake.mjs
bun scripts/test-git-prompt-live.ts
```

These checks do not establish GUI click, app shortcut, clipboard, font, or window-focus behavior. Tests for those behaviors must use the real target app with separate ownership and permission.

## Measurements

Record the terminal backend and measurement boundary in every report. Rex startup can include terminal creation, `login`, target registration, and capture delay. Do not compare that value with historic tmux respawn timings as proof of a speed change.

CPU and RSS sampled for a Pi host exclude Rex, the supervisor, the controller, and the sampler. A zero CPU delta means below the sampling resolution, not zero work.

## References

- [Rex CLI](https://www.superlogical.com/rex/docs/reference/cli)
- [Rex server API](https://www.superlogical.com/rex/docs/reference/api)
- [Rex shell scripting](https://www.superlogical.com/rex/docs/automate/shell-scripting)
- [Migration tracking and acceptance checks](https://github.com/luiul/dotfiles/issues/103)
