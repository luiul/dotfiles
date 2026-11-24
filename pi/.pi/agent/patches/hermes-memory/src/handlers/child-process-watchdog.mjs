import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

const [timeoutValue, cancellationPath, ownerPath, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);
if (!cancellationPath || !command || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
  process.stderr.write("pi-hermes-memory watchdog: invalid invocation\n");
  process.exit(2);
}
if (process.platform === "win32") {
  process.stderr.write("pi-hermes-memory watchdog: pinned group ownership needs POSIX\n");
  process.exit(2);
}

// The shell remains the live group leader until cleanup. Its control pipe
// closes if this watchdog dies. The workload cannot inherit that pipe or fd 3.
// Reset INT/QUIT ignored by the shell's asynchronous child before exec.
const anchor = [
  '(',
  '  /usr/bin/perl -e \'$SIG{INT}="DEFAULT"; $SIG{QUIT}="DEFAULT"; exec {$ARGV[0]} @ARGV or die "exec: $!";\' -- "$@" < /dev/null 3>&-',
  '  status=$?',
  '  printf "%s\\n" "$status" >&3',
  ') &',
  'trap "" TERM INT',
  'exec 1>&- 2>&- 3>&-',
  'IFS= read -r control',
  'kill -KILL -- "-$$"',
].join("\n");
const child = spawn("/bin/sh", ["-c", anchor, "hermes-review", command, ...args], {
  detached: true,
  env: { ...process.env, PI_HERMES_MEMORY_CHILD: "1" },
  stdio: ["pipe", "pipe", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
let code, stopping = false, closed = false, forceTimer, drainTimer, owner;
const signalGroup = signal => {
  // No remembered PGID after the owned leader exits, and no PID polling.
  if (closed || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};
function stop(result) {
  if (stopping) return;
  stopping = true;
  code = result;
  signalGroup("SIGTERM");
  // Root exit does not cancel escalation. Replacements still belong to the
  // pinned group, even if they redirect streams or outlive the original root.
  forceTimer = setTimeout(() => {
    signalGroup("SIGKILL");
    child.stdin.destroy();
    drainTimer = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy(); child.stdio[3].destroy();
    }, 300);
  }, 500);
}
function complete(result) {
  if (stopping) return; // Cancellation owns its retained TERM/KILL escalation.
  stopping = true;
  code = result;
  // Workload status is final. Reclaim replacements while our leader still
  // pins the group, without the cancellation grace period. Drain queued output.
  signalGroup("SIGKILL");
  child.stdin.destroy();
  drainTimer = setTimeout(() => {
    code = 1; // Escaped pipes or undrained output cannot count as success.
    child.stdout.destroy(); child.stderr.destroy(); child.stdio[3].destroy();
  }, 5000);
}
const timeout = setTimeout(() => {
  process.stderr.write(`[pi-hermes-memory] child timed out after ${timeoutMs}ms; terminating process tree\n`);
  stop(124);
}, timeoutMs);
const cancellationPoll = cancellationPath === "-" ? undefined : setInterval(() => {
  if (existsSync(cancellationPath)) stop(143);
}, 25);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(143));

// execChildPrompt supplies a private owner socket. EOF detects host death
// without querying or signaling a potentially recycled parent PID.
if (ownerPath && ownerPath !== "-") {
  owner = createConnection(ownerPath);
  owner.on("error", () => stop(143));
  owner.on("end", () => stop(143));
  owner.on("close", () => { if (!closed) stop(143); });
}
let status = "";
child.stdio[3].on("data", chunk => {
  status += chunk.toString();
  if (status.includes("\n")) {
    const value = status.trim();
    if (/^\d{1,3}$/.test(value) && Number(value) <= 255) complete(Number(value));
    else stop(1);
  }
});
child.once("error", error => {
  process.stderr.write(`pi-hermes-memory watchdog: ${error.message}\n`);
  stop(127);
});
child.once("close", () => {
  closed = true;
  clearTimeout(timeout); clearInterval(cancellationPoll);
  clearTimeout(forceTimer); clearTimeout(drainTimer);
  child.stdin.destroy(); child.stdio[3].destroy(); owner?.destroy();
  process.exitCode = code ?? 1;
});
