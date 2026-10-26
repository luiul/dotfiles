// Run with bun. Real login shells and keyboard input, no LLM or GUI needed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "git-prompt-live-"));
const sessions = new Set<string>();
let count = 0;
let commandCount = 0;
function run(command: string, args: string[], cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
  count++;
}
function screen(session: string) {
  return run("tmux", ["capture-pane", "-p", "-S", "-250", "-t", session]);
}
async function command(session: string, text: string, timeout = 4000) {
  const marker = `PROMPT_TEST_DONE_${++commandCount}`;
  run("tmux", ["send-keys", "-t", session, "-l", `${text}; print -r -- ${marker}`]);
  run("tmux", ["send-keys", "-t", session, "Enter"]);
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const capture = screen(session);
    if (capture.split("\n").includes(marker)) return capture;
    await wait(30);
  }
  throw new Error(`Command timed out: ${text}\n${screen(session)}`);
}
async function open(dir: string, suffix: string) {
  const session = `ag-prompt-live-${process.pid}-${suffix}`;
  sessions.add(session);
  run("tmux", ["new-session", "-d", "-s", session, "-x", "180", "-y", "45", "-c", dir, "/bin/zsh -il"]);
  await wait(700);
  return session;
}
function close(session: string) {
  spawnSync("tmux", ["kill-session", "-t", session]);
  sessions.delete(session);
}

try {
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
  const normal = await open(plain, "normal");
  await wait(500);
  let capture = await command(normal, 'print -r -- "DAEMON=$_my_prompt_gitstatus_ok PENDING=$_my_prompt_daemon_pending FD=$_my_prompt_fd"');
  for (let attempt = 0; attempt < 30 && !capture.includes("DAEMON=1 PENDING=0 FD=-1"); attempt++) {
    await wait(100);
    capture = await command(normal, 'print -r -- "DAEMON=$_my_prompt_gitstatus_ok PENDING=$_my_prompt_daemon_pending FD=$_my_prompt_fd"');
  }
  check(capture.includes("DAEMON=1 PENDING=0 FD=-1"), "daemon starts asynchronously and settles");
  capture = await command(normal, 'print -r -- "COMPS=${_comps[mole]}|${_comps[mo]}|${_comps[wt]} FZF=$+widgets[fzf-history-widget] ZOXIDE=$+functions[__zoxide_z]"');
  check(capture.includes("COMPS=_mole|_mole|_wt_cached FZF=1 ZOXIDE=1"), "completion mappings, fzf, and zoxide remain ready");
  run("tmux", ["send-keys", "-t", normal, "-l", "mo "]);
  run("tmux", ["send-keys", "-t", normal, "Tab"]);
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(100);
    capture = screen(normal);
    if (capture.includes("Explore disk usage")) break;
  }
  check(capture.includes("mo analyze") && capture.includes("Explore disk usage"), "Mole Tab shows real subcommands");
  run("tmux", ["send-keys", "-t", normal, "C-c"]);
  run("tmux", ["send-keys", "-t", normal, "-l", "git ch"]);
  await wait(400);
  capture = screen(normal);
  check(capture.includes("checkout") || capture.includes("cherry-pick"), "live Git completion still works");
  run("tmux", ["send-keys", "-t", normal, "C-c"]);
  await command(normal, `builtin cd '${filtered}'`);
  await wait(450);
  capture = await command(normal, 'print -r -- "FILTERED=$_my_prompt_git CACHE=${_my_prompt_git_filters[$PWD]}"; gst');
  check(capture.includes("FILTERED= %F{114}(main)%f CACHE=1"), "clean filters match Git status");
  writeFileSync(join(filtered, "tracked.txt"), "changed\nruntime=two\n");
  await command(normal, ":");
  await wait(400);
  capture = await command(normal, 'print -r -- "REAL_EDIT=$_my_prompt_git"');
  check(capture.includes("REAL_EDIT= %F{210}(main)%f U[%F{222}~1%f]"), "real filtered changes remain visible");
  run("tmux", ["send-keys", "-t", normal, "-l", "false"]);
  run("tmux", ["send-keys", "-t", normal, "Enter"]);
  await wait(500);
  check(screen(normal).includes("$ [1]"), "failure code survives asynchronous redraw");
  await command(normal, "sleep 3.1");
  check(screen(normal).includes("took 3."), "slow command duration is visible");
  capture = await command(normal, 'print -r -- "TIMERS=${#zsh_scheduled_events} FD=$_my_prompt_fd"');
  check(capture.includes("TIMERS=0 FD=-1"), "completed work removes timers and descriptors");
  close(normal);

  const slow = await open(filtered, "slow");
  await command(slow, "_my_prompt_git_worker() { print -rn -- $'1\\t'; sleep 3; print -r -- ' (slow)'; }");
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
  const shell = readFileSync(shellPidFile, "utf8").trim();
  run("tmux", ["send-keys", "-t", shutdown, "-l", "exit"]);
  run("tmux", ["send-keys", "-t", shutdown, "Enter"]);
  await wait(500);
  const afterExit = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout;
  check(!afterExit.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === shell || fields[1] === shell || fields[2] === group;
  }), "shell exit leaves no worker or direct child behind");
  close(shutdown);
  const failing = await open(plain, "daemon-failure");
  await command(failing, "_my_prompt_daemon_failed; _my_prompt_daemon_retry=0; _my_prompt_daemon_attempts=0; gitstatus_start() { if [[ $1 == -a ]]; then local fd; exec {fd}< <(print -r -- ready); typeset -g _GITSTATUS_RESP_FD_MYPROMPT=$fd; return 0; fi; return 1; }; gitstatus_stop() { :; }");
  writeFileSync(join(plain, "tracked.txt"), "change-after-startup\n");
  await command(failing, ":");
  await wait(600);
  check(screen(failing).includes("U[~1]"), "daemon startup failure refreshes through fallback without another command");
  close(failing);
  console.log(`${count} live tests passed.`);
} finally {
  for (const session of sessions) close(session);
  rmSync(fixture, { recursive: true, force: true });
}
