// Run with bun. Real login shells and keyboard input, no LLM or GUI needed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { RexTestDriver } from "./rex-test-driver.mjs";

type Host = ReturnType<RexTestDriver["create"]>;
const repo = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "git-prompt-live-"));
const sessions = new Set<Host>();
// Use the real login setup, but load candidate prompt code before its first
// precmd. Do not rewrite the live prompt or print the login environment.
const zdotdir = join(fixture, "zdotdir");
mkdirSync(zdotdir);
writeFileSync(join(zdotdir, ".zshenv"), `source '${homedir()}/.zshenv'\n`);
writeFileSync(join(zdotdir, ".zshrc"), `source '${homedir()}/.zshrc'\n_my_prompt_shutdown\nfor hook in precmd preexec chpwd; do add-zsh-hook -d $hook _my_prompt_$hook; done\nadd-zsh-hook -d zshexit _my_prompt_shutdown\nsource '${repo}/zsh/.zsh_config/prompt.zsh'\n`);
// The real binary starts late. The early process header still arrives first.
writeFileSync(join(fixture, "gitconfig"), "");
const delayedDaemon = join(fixture, "delayed-gitstatusd");
const daemonBinary = join(homedir(), ".cache/gitstatus/gitstatusd-darwin-arm64");
const daemonVersion = spawnSync(daemonBinary, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout.trim();
if (!/^v\d+\.\d+\.\d+$/.test(daemonVersion)) throw new Error("Missing daemon version");
writeFileSync(delayedDaemon, `#!/bin/sh\nsleep 1\n[ "$1" = -G ] && shift 2\nexec '${daemonBinary}' -G '${daemonVersion}' "$@"\n`, { mode: 0o700 });
let driver: RexTestDriver;
let count = 0;
let commandCount = 0;
function run(command: string, args: string[], cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(ok: boolean, label: string, details = "") {
  if (!ok) throw new Error(`FAIL: ${label}${details ? `\n${details}` : ""}`);
  console.log(`PASS: ${label}`);
  count++;
}
function screen(session: Host) {
  // Prompt assertions include earlier output, not just the current viewport.
  return driver.capture(session, { history: true });
}
async function command(session: Host, text: string, timeout = 4000) {
  const marker = `PROMPT_TEST_DONE_${++commandCount}`;
  driver.text(session, `${text}; print -r -- ${marker}`);
  driver.key(session, "enter");
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const capture = screen(session);
    if (capture.split("\n").includes(marker)) return capture;
    await wait(30);
  }
  throw new Error(`Command timed out: ${text}\n${screen(session)}`);
}
async function open(dir: string, suffix: string, extraEnv: Record<string, string> = {}) {
  // The driver uses env -i. Preserve the login shell's HOME and tool PATH.
  const session = driver.create({
    name: `ag-prompt-live-${process.pid}-${suffix}`,
    command: ["/bin/zsh", "-il"], cwd: dir, columns: 180, rows: 45,
    env: { HOME: homedir(), PATH: process.env.PATH!, TERM: "xterm-256color", ZDOTDIR: zdotdir,
      GIT_CONFIG_GLOBAL: join(fixture, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", ...extraEnv },
  });
  sessions.add(session);
  const deadline = performance.now() + 15000;
  while (!screen(session).split("\n").some(line => line.startsWith("╰─ $"))) {
    if (performance.now() >= deadline) throw new Error("Login shell did not show its first prompt");
    await wait(100);
  }
  return session;
}
function close(session: Host) {
  driver.close(session);
  sessions.delete(session);
}

try {
  driver = await RexTestDriver.start({ deadlineMs: 6 * 60_000 });
  for (const kind of ["plain", "filtered"]) {
    const dir = join(fixture, kind);
    mkdirSync(dir);
    run("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "tracked.txt"), "stable\nruntime=one\n");
    if (kind === "filtered") {
      writeFileSync(join(dir, ".gitattributes"), "tracked.txt filter=strip-runtime\n");
      run("git", ["config", "filter.strip-runtime.clean", "sed '/^runtime=/d'"], dir);
    }
    run("git", ["add", "."], dir);
    run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], dir);
  }
  const plain = join(fixture, "plain");
  const filtered = join(fixture, "filtered");
  writeFileSync(join(filtered, "tracked.txt"), "stable\nruntime=two\n");
  const delayed = await open(plain, "delayed", { GITSTATUS_DAEMON: delayedDaemon });
  let capture = await command(delayed, 'print -r -- INPUT_DURING_HANDSHAKE');
  check(capture.split("\n").includes("INPUT_DURING_HANDSHAKE"), "input works while the real daemon handshake is delayed");
  for (let attempt = 0; attempt < 30 && !capture.includes("READY=1 STATE=2"); attempt++) {
    await wait(1200);
    capture = await command(delayed, 'print -r -- "READY=$_my_prompt_gitstatus_ok STATE=${_GITSTATUS_STATE_MYPROMPT:-0} STAGE=$_my_prompt_daemon_stage FD=$_my_prompt_daemon_start_fd ATTEMPTS=$_my_prompt_daemon_attempts CONTRACT=$(_my_prompt_daemon_contract; print $?)"');
  }
  check(capture.includes("READY=1 STATE=2"), "delayed real daemon reaches handshake completion", capture);
  capture = await command(delayed, 'print -r -- "START_FD=$_my_prompt_daemon_start_fd TIMERS=${#zsh_scheduled_events}"');
  check(capture.includes("START_FD=-1 TIMERS=0"), "delayed startup clears its watcher and timers");
  close(delayed);
  const normal = await open(plain, "normal");
  await wait(500);
  capture = await command(normal, 'print -r -- "DAEMON=$_my_prompt_gitstatus_ok PENDING=$_my_prompt_daemon_pending FD=$_my_prompt_fd"');
  for (let attempt = 0; attempt < 30 && !capture.includes("DAEMON=1 PENDING=0 FD=-1"); attempt++) {
    // Give the background first-visit Git worker time to publish. A command
    // cancels that worker by design, so rapid polling can starve readiness.
    await wait(1200);
    capture = await command(normal, 'print -r -- "DAEMON=$_my_prompt_gitstatus_ok PENDING=$_my_prompt_daemon_pending FD=$_my_prompt_fd"');
  }
  check(capture.includes("DAEMON=1 PENDING=0 FD=-1"), "daemon starts asynchronously and settles", capture);
  capture = await command(normal, 'print -r -- "COMPS=${_comps[mole]}|${_comps[mo]}|${_comps[wt]} FZF=$+widgets[fzf-history-widget] ZOXIDE=$+functions[__zoxide_z]"');
  check(capture.includes("COMPS=_mole|_mole|_wt_cached FZF=1 ZOXIDE=1"), "completion mappings, fzf, and zoxide remain ready");
  driver.text(normal, "mo ");
  driver.key(normal, "tab");
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(100);
    capture = screen(normal);
    if (capture.includes("Explore disk usage")) break;
  }
  check(capture.includes("mo analyze") && capture.includes("Explore disk usage"), "Mole Tab shows real subcommands");
  driver.key(normal, "ctrl+c");
  driver.text(normal, "git ch");
  for (let attempt = 0; attempt < 80; attempt++) {
    await wait(100);
    capture = screen(normal);
    if (capture.includes("checkout") || capture.includes("cherry-pick")) break;
  }
  check(capture.includes("checkout") || capture.includes("cherry-pick"), "live Git completion still works", capture);
  driver.key(normal, "ctrl+c");
  await command(normal, `builtin cd '${filtered}'`);
  await wait(4500);
  capture = await command(normal, 'print -r -- "FILTERED=$_my_prompt_git CACHE=${_my_prompt_git_filters[$PWD]}"; gst');
  check(capture.includes("FILTERED= %F{114}(main)%f CACHE=1"), "clean filters match Git status", capture);
  writeFileSync(join(filtered, "tracked.txt"), "changed\nruntime=two\n");
  await command(normal, ":");
  await wait(4500);
  capture = await command(normal, 'print -r -- "REAL_EDIT=$_my_prompt_git"');
  check(capture.includes("REAL_EDIT= %F{210}(main)%f U[%F{222}~1%f]"), "real filtered changes remain visible", capture);
  driver.text(normal, "false");
  driver.key(normal, "enter");
  await wait(500);
  check(screen(normal).includes("$ [1]"), "failure code survives asynchronous redraw");
  await command(normal, "sleep 3.1");
  check(screen(normal).includes("took 3."), "slow command duration is visible");
  await wait(4500);
  capture = await command(normal, 'print -r -- "TIMERS=${#zsh_scheduled_events} FD=$_my_prompt_fd"');
  check(capture.includes("TIMERS=0 FD=-1"), "completed work removes timers and descriptors");
  close(normal);

  const slow = await open(filtered, "slow");
  await command(slow, "_my_prompt_git_worker() { _my_prompt_filter_fingerprint; print -rn -- $'1\\t'\"${(q)REPLY}\"$'\\t'; sleep 3; print -r -- ' (slow)'; }");
  await wait(100);
  const start = performance.now();
  capture = await command(slow, 'print -r -- INPUT_RESPONSIVE', 1200);
  check(capture.split("\n").includes("INPUT_RESPONSIVE") && performance.now() - start < 1000, "partial worker records cannot block keyboard input");
  capture = await command(slow, 'print -r -- "WORKER_PID=$_my_prompt_worker_pid"');
  const pidMatch = capture.match(/^WORKER_PID=(\d+)$/m);
  if (!pidMatch) throw new Error("Missing worker pid");
  await command(slow, `builtin cd '${plain}'`);
  await wait(100);
  const processes = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).stdout;
  check(!processes.split("\n").some((line) => line.trim().split(/\s+/)[1] === pidMatch[1]), "changing directory kills the old worker group");
  await command(slow, "_my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'");
  await wait(6000);
  capture = screen(slow);
  check(capture.includes("git:?"), "slow workers stop at deadline and show unknown status");
  capture = await command(slow, 'print -r -- "DEADLINE_FD=$_my_prompt_fd DEADLINE_PID=$_my_prompt_worker_pid"');
  check(capture.includes("DEADLINE_FD=-1 DEADLINE_PID=0"), "worker deadline cleans up process and descriptor");
  const beforeNoMonitor = join(fixture, "no-monitor-worker");
  await command(slow, `unsetopt monitor; _my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'`);
  await command(slow, `print -r -- "$_my_prompt_worker_pid" > '${beforeNoMonitor}'; print -r -- "USER_MONITOR=$options[monitor]"`);
  check(screen(slow).includes("USER_MONITOR=off"), "worker launch preserves disabled job control");
  const noMonitorGroup = readFileSync(beforeNoMonitor, "utf8").trim();
  await command(slow, `builtin cd '${filtered}'`);
  const noMonitorProcesses = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).stdout;
  check(!noMonitorProcesses.split("\n").some((line) => line.trim().split(/\s+/)[1] === noMonitorGroup), "cancellation kills descendants when job control is disabled");
  close(slow);
  const shellPidFile = join(fixture, "shutdown-shell");
  const shutdownPidFile = join(fixture, "shutdown-worker");
  const shutdown = await open(filtered, "shutdown");
  await command(shutdown, `print -r -- $$ > '${shellPidFile}'; _my_prompt_git_worker() { sleep 20; }`);
  await command(shutdown, `print -r -- "$_my_prompt_worker_pid" > '${shutdownPidFile}'`);
  const group = readFileSync(shutdownPidFile, "utf8").trim();
  const shell = String(driver.pid(shutdown));
  check(shell === readFileSync(shellPidFile, "utf8").trim(), "driver records the actual login shell PID");
  driver.text(shutdown, "exit");
  driver.key(shutdown, "enter");
  await wait(500);
  const afterExit = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout;
  check(!afterExit.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === shell || fields[1] === shell || fields[2] === group;
  }), "shell exit leaves no worker or direct child behind");
  close(shutdown);
  const failing = await open(plain, "daemon-failure");
  await command(failing, "_my_prompt_daemon_failed; _my_prompt_daemon_retry=0; _my_prompt_daemon_attempts=0; _my_prompt_daemon_contract() { return 0; }; gitstatus_start() { if [[ $1 == -a ]]; then local fd; exec {fd}< <(print -r -- broken); typeset -g _GITSTATUS_RESP_FD_MYPROMPT=$fd _GITSTATUS_STATE_MYPROMPT=1 _GITSTATUS_CLIENT_PID_MYPROMPT=$sysparams[pid]; return 0; fi; return 1; }; gitstatus_stop() { [[ ${_GITSTATUS_RESP_FD_MYPROMPT:-} == <-> ]] && exec {_GITSTATUS_RESP_FD_MYPROMPT}<&-; }");
  writeFileSync(join(plain, "tracked.txt"), "change-after-startup\n");
  await command(failing, ":");
  await wait(4500);
  check(screen(failing).includes("U[~1]"), "daemon startup failure refreshes through fallback without another command");
  close(failing);
  console.log(`${count} live tests passed.`);
} finally {
  try {
    for (const session of sessions) close(session);
  } finally {
    let stopped = false;
    try {
      await driver?.stop(); stopped = true;
    } finally {
      if (stopped) rmSync(fixture, { recursive: true, force: true });
      else console.error(`Cleanup unresolved; fixture preserved at ${fixture}`);
    }
  }
}
