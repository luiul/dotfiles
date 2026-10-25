// Run with bun. Real login shells and keyboard input, no LLM or GUI needed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "..");
const fixture = mkdtempSync(join(tmpdir(), "git-prompt-live-"));
const sessions = new Set<string>();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Use the checkout under test, not stowed files from another active checkout.
const shellConfig = join(fixture, "shell-config");
mkdirSync(shellConfig);
writeFileSync(join(shellConfig, ".zshenv"), `source ${quote(join(repo, "zsh/.zshenv"))}\n`);
writeFileSync(join(shellConfig, ".zshrc"), `typeset -g ZSH_CONFIG_DIR=${quote(join(repo, "zsh/.zsh_config"))}\nsource ${quote(join(repo, "zsh/.zshrc"))}\nHISTFILE=${quote(join(fixture, "history"))}\n`);
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
  run("tmux", ["new-session", "-d", "-s", session, "-x", "180", "-y", "45", "-c", dir, `env ZDOTDIR=${quote(shellConfig)} /bin/zsh -il`]);
  const reaper = join(process.env.HOME!, ".local/bin/reap-strays");
  if (existsSync(reaper)) {
    run(reaper, ["--register-tmux", session, "--owner", String(process.pid), "--deadline", String(Math.floor(Date.now() / 1000) + 120)]);
  }
  await wait(700);
  return session;
}
function close(session: string) {
  spawnSync("tmux", ["kill-session", "-t", session]);
  sessions.delete(session);
}
function processes() {
  return run("ps", ["-axo", "pid=,ppid=,pgid=,command="]).trim().split("\n").map((line) => {
    const [pid, parent, group, ...args] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), command: args.join(" ") };
  });
}
type Worker = { shell: number; pid: number; group: number };
async function recordWorker(session: string, suffix: string, setup: string, monitor = "on"): Promise<Worker> {
  const file = join(fixture, `${suffix}-worker`);
  // command() runs preexec before evaluating its text. A capture there would
  // read PID 0 after cancellation. Record from precmd, after the actual launch.
  await command(session, `${setup}; add-zsh-hook -d precmd _prompt_test_record_worker; _prompt_test_record_worker() { (( _my_prompt_worker_pid > 0 )) && print -r -- "$$ $_my_prompt_worker_pid $_my_prompt_worker_group $options[monitor]" > ${quote(file)}; }; add-zsh-hook precmd _prompt_test_record_worker`);
  for (let attempt = 0; attempt < 40 && !existsSync(file); attempt++) await wait(25);
  if (!existsSync(file)) throw new Error(`Missing post-launch worker record: ${suffix}`);
  const [shell, pid, owned, userMonitor] = readFileSync(file, "utf8").trim().split(/\s+/);
  const shellPid = Number(shell), workerPid = Number(pid);
  check(Number.isSafeInteger(shellPid) && shellPid > 0 && Number.isSafeInteger(workerPid) && workerPid > 0 && owned === "1", `${suffix}: post-launch record has a positive owned worker PID`);
  const current = processes();
  const owner = current.find((row) => row.pid === shellPid);
  const leader = current.find((row) => row.pid === workerPid);
  check(!!owner && !!leader && leader.parent === shellPid && leader.group === workerPid && leader.group > 0 && leader.group !== owner.group, `${suffix}: worker PID=${workerPid} PGID=${leader?.group} exists outside shell PGID=${owner?.group}`);
  let hasDescendant = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    hasDescendant = processes().some((row) => row.group === workerPid && row.pid !== workerPid && /\bsleep 20\b/.test(row.command));
    if (hasDescendant) break;
    await wait(25);
  }
  check(hasDescendant, `${suffix}: recorded worker group contains a live sleep descendant before cancellation`);
  check(userMonitor === monitor, `${suffix}: worker launch preserves monitor=${monitor}`);
  return { shell: shellPid, pid: workerPid, group: leader!.group };
}
async function groupGone(worker: Worker, label: string, includeShell = false) {
  // Reject invalid records before checking absence, never search for group 0.
  if (worker.pid <= 0 || worker.group <= 0 || worker.shell <= 0) throw new Error("Invalid worker identity");
  for (let attempt = 0; attempt < 80; attempt++) {
    const remaining = processes().filter((row) => row.group === worker.group || (includeShell && (row.pid === worker.shell || row.parent === worker.shell)));
    if (!remaining.length) { check(true, label); return; }
    if (attempt === 79) throw new Error(`${label}: remaining ${JSON.stringify(remaining)}`);
    await wait(25);
  }
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
  let capture = await command(normal, 'print -r -- "CONFIG=$zsh_config_dir SUBST=$options[promptsubst]"');
  check(capture.split("\n").includes(`CONFIG=${join(repo, "zsh/.zsh_config")} SUBST=off`), "live shell loads this checkout with shell substitution disabled");
  capture = await command(normal, 'print -r -- "DAEMON=$_my_prompt_gitstatus_ok PENDING=$_my_prompt_daemon_pending FD=$_my_prompt_fd"');
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
  // Without preexec cancellation, this checks chpwd itself, not merely the
  // command used to read the PID or the command's next precmd refresh.
  const directoryWorker = await recordWorker(slow, "directory", "add-zsh-hook -d preexec _my_prompt_preexec; _my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'");
  await command(slow, `add-zsh-hook -d precmd _my_prompt_precmd; builtin cd ${quote(plain)}`);
  await groupGone(directoryWorker, "changing directory kills the recorded old worker group without preexec or precmd cancellation");
  await command(slow, "add-zsh-hook precmd _my_prompt_precmd; _my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'");
  await wait(6000);
  capture = screen(slow);
  check(capture.includes("git:?"), "slow workers stop at deadline and show unknown status");
  capture = await command(slow, 'print -r -- "DEADLINE_FD=$_my_prompt_fd DEADLINE_PID=$_my_prompt_worker_pid"');
  check(capture.includes("DEADLINE_FD=-1 DEADLINE_PID=0"), "worker deadline cleans up process and descriptor");
  const noMonitorWorker = await recordWorker(slow, "no-monitor", "unsetopt monitor; _my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'", "off");
  await command(slow, `add-zsh-hook -d precmd _my_prompt_precmd; builtin cd ${quote(filtered)}`);
  await groupGone(noMonitorWorker, "cancellation kills the recorded worker group when job control is disabled");
  close(slow);
  const shutdown = await open(filtered, "shutdown");
  const shutdownWorker = await recordWorker(shutdown, "shutdown", "add-zsh-hook -d preexec _my_prompt_preexec; _my_prompt_git_worker() { sleep 20; }; unset '_my_prompt_git_filters[$PWD]'");
  run("tmux", ["send-keys", "-t", shutdown, "-l", "exit"]);
  run("tmux", ["send-keys", "-t", shutdown, "Enter"]);
  await groupGone(shutdownWorker, "shell exit leaves no recorded worker group or direct child behind", true);
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
