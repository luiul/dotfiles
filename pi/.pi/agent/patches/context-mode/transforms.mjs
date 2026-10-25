// Reviewed transformations for context-mode 1.0.169. Not a Pi extension.
function replace(source, oldText, newText) {
  if (source.split(oldText).length !== 2) throw new Error('Patch anchor mismatch');
  return source.replace(oldText, newText);
}
function section(source, start, end, body) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) >= 0) throw new Error('Patch section mismatch');
  return source.slice(0, a) + body + source.slice(b);
}
export function bridge(source) {
  source = section(source, '// Bridge-imposed timeout', '// Retry budget', `// Local resource policy: calls are bounded, explicit execution budgets may be longer.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const TOOL_GRACE_MS = 10_000;
export function toolBudget(name, args = {}) {
    const execution = ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"].includes(name);
    const params = { ...args };
    if (!execution) return { params, timeout: DEFAULT_TOOL_TIMEOUT_MS };
    if (params.background === true && params.timeout === undefined)
        throw new Error("background requires an explicit positive timeout and shutdown ownership");
    const timeout = params.timeout === undefined ? DEFAULT_TOOL_TIMEOUT_MS : Number(params.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647 - TOOL_GRACE_MS)
        throw new Error("timeout must be positive, finite and within the Node timer range");
    params.timeout = timeout;
    let waves = 1;
    if (name === "ctx_batch_execute") {
        const concurrency = Number(params.concurrency ?? 1);
        if (concurrency > 1) waves = Math.max(1, Math.ceil((params.commands?.length ?? 0) / concurrency));
    }
    const budget = timeout * waves + TOOL_GRACE_MS * waves;
    if (!Number.isSafeInteger(Math.ceil(budget)) || budget > 2147483647)
        throw new Error("batch RPC budget exceeds the Node timer range");
    return { params, timeout: budget };
}
`);
  source = replace(source, '        this.notify("notifications/initialized", {});\n        this.initialized = true;', '        if (generation !== this.generation || this.exited) throw new Error("MCP initialization cancelled");\n        this.notify("notifications/initialized", {});\n        this.initialized = true;');
  source = replace(source, '        await this.request("initialize", {', '        const generation = this.generation;\n        await this.request("initialize", {');
  source = replace(source, '    _spawnEnv = null;', '    _spawnEnv = null;\n    generation = 0;');
  source = replace(source, '            ...this.env,\n            [BRIDGE_DEPTH_ENV]', '            ...this.env,\n            CONTEXT_MODE_DIRECT_PARENT: "1",\n            [BRIDGE_DEPTH_ENV]');
  source = replace(source, '        this.child.stdout?.on("data", (chunk) => this.onData(chunk));', `        const child = this.child;
        child.stdout?.on("data", (chunk) => { if (this.child === child) this.onData(chunk); });
        child.stdin?.on("error", () => { if (this.child === child) this.shutdown(new Error("MCP stdin failed")); });`);
  source = replace(source, '        this.child.on("exit", () => this.onExit());\n        this.child.on("error", () => this.onExit());', '        child.on("exit", () => this.onExit(child));\n        child.on("error", () => this.onExit(child));');
  source = section(source, '    onExit() {', '    onData(chunk) {', `    onExit(child = this.child) {
        if (child !== this.child) return;
        this.exited = true;
        this.initialized = false;
        const err = new Error("MCP server exited");
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
    }
`);
  source = section(source, '    async request(method, params, timeoutMs', '    writeFrame(frame, onError) {', `    async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal) {
        if (signal?.aborted) throw new Error("MCP request aborted");
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
            throw new Error("MCP timeout must be positive and finite");
        if (this.exited) {
            if (!this.respawnPromise) {
                const promise = this.respawn();
                this.respawnPromise = promise;
                promise.finally(() => {
                    if (this.respawnPromise === promise) this.respawnPromise = null;
                }).catch(() => {});
            }
            if (signal) {
                await new Promise((resolve, reject) => {
                    const abort = () => {
                        this.shutdown(new Error("MCP request aborted during respawn"));
                        reject(new Error("MCP request aborted"));
                    };
                    signal.addEventListener("abort", abort, { once: true });
                    this.respawnPromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
                    if (signal.aborted) abort();
                });
            } else await this.respawnPromise;
        }
        if (signal?.aborted) throw new Error("MCP request aborted");
        if (!this.child || this.exited) throw new Error("MCP client not started");
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
            const settle = (fn, value) => { cleanup(); fn(value); };
            const cancel = (reason) => {
                if (!this.pending.has(id)) return;
                this.notify("notifications/cancelled", { requestId: id, reason });
                // The server has no per-execution cancellation ownership. Reclaim it.
                // All sibling requests fail explicitly; the next call may respawn.
                this.shutdown(new Error(reason + "; MCP bridge reclaimed, sibling calls cancelled"));
            };
            const abort = () => cancel("MCP request aborted");
            this.pending.set(id, { resolve: v => settle(resolve, v), reject: e => settle(reject, e) });
            timer = setTimeout(() => cancel("MCP request timeout after " + timeoutMs + "ms: " + method), timeoutMs);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            try {
                this.writeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params }), err => this.pending.get(id)?.reject(err));
            } catch (err) { this.pending.get(id)?.reject(err); }
        });
    }
`);
  source = replace(source, '        const stdin = this.child.stdin;', '        const child = this.child;\n        const stdin = child.stdin;');
  // A delayed old pipe error cannot poison a replacement child.
  source = source.replaceAll('                    this.onExit();', '                    this.onExit(child);');
  source = replace(source, '                this.onExit();\n                onError?.(err);', '                this.onExit(child);\n                onError?.(err);');
  source = section(source, '    async callTool(name, args) {', '    /**\n     * Respawn the MCP child', `    async callTool(name, args, signal) {
        if (signal?.aborted) throw new Error("MCP request aborted");
        const { params, timeout } = toolBudget(name, args);
        return this.request("tools/call", { name, arguments: params }, timeout, signal);
    }
`);
  source = replace(source, '        this.start();\n        await this.initialize();\n    }\n    shutdown() {', `        const generation = this.generation;
        this.start();
        try {
            await this.initialize();
            if (generation !== this.generation) throw new Error("MCP respawn cancelled");
        } catch (err) {
            if (generation === this.generation) this.shutdown(err);
            throw err;
        }
    }
    shutdown(reason = new Error("MCP bridge shut down; all pending calls cancelled")) {`);
  source = replace(source, '        if (!this.child)\n            return;\n        const child = this.child;', `        this.generation++;
        for (const [, p] of this.pending) p.reject(reason);
        this.pending.clear();
        const child = this.child;
        this.child = null;
        this.initialized = false;
        this.exited = true;
        this.buffer = "";
        if (!child) return;`);
  // Keep stdout attached until server exits: it may be flushing cancellation metadata.
  source = replace(source, '        setTimeout(() => {\n            try {\n                if (child.exitCode', '        const killTimer = setTimeout(() => {\n            try {\n                if (child.exitCode');
  source = replace(source, '        }, 5000).unref();\n        this.child = null;\n        this.initialized = false;\n        this.exited = true;', `        }, 5000);
        child.once("close", () => clearTimeout(killTimer));`);
  source = replace(source, '            lastError = err;\n            if (attempt', '            lastError = err;\n            client.shutdown(err);\n            if (attempt');
  source = replace(source, '    const tools = await client.listTools();', '    try {\n    const tools = await client.listTools();');
  source = replace(source, '            async execute(_toolCallId, params) {\n                const result = await client.callTool(tool.name, params ?? {});', '            async execute(_toolCallId, params, signal) {\n                const result = await client.callTool(tool.name, params ?? {}, signal);');
  source = replace(source, '        client,\n    };\n}', '        client,\n    };\n    } catch (err) {\n        client.shutdown(err);\n        throw err;\n    }\n}');
  return source;
}
export function executor(source) {
  source = replace(source, '{ env: { ...process.env, TMPDIR: undefined }, encoding: "utf-8" }', '{ env: { ...process.env, TMPDIR: undefined }, encoding: "utf-8", timeout: 2000, killSignal: "SIGKILL" }');
  source = section(source, '/** Kill process tree', 'export class PolyglotExecutor {', `// Ownership is a ChildProcess handle until close, not a remembered PID.
// After root exit, capture surviving group members and their start identities.
// No delayed signal is sent based on a recycled group ID alone.
function groupMembers(pid) {
    if (isWin || !pid) return new Map();
    try {
        const rows = execFileSync("ps", ["-axo", "pid=,pgid=,lstart="], {
            encoding: "utf-8", timeout: 2000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"]
        });
        const members = new Map();
        for (const row of rows.trim().split("\\n")) {
            const match = row.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
            if (match && Number(match[2]) === pid) members.set(Number(match[1]), match[3]);
        }
        return members;
    } catch { return new Map(); }
}
function ownsGroup(proc) {
    if (!proc.pid || proc._cmClosed) return false;
    if (proc.exitCode === null && proc.signalCode === null) return true;
    const current = groupMembers(proc.pid);
    return [...(proc._cmMembers ?? [])].some(([pid, start]) => current.get(pid) === start);
}
function killTree(proc, signal = "SIGKILL") {
    if (!ownsGroup(proc)) return;
    try {
        if (isWin) execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
            stdio: "pipe", timeout: 2000, killSignal: "SIGKILL"
        });
        else process.kill(-proc.pid, signal);
    } catch { /* group already gone */ }
}
`);
  source = replace(source, '    /** PIDs of backgrounded processes — killed on cleanup to prevent zombies. */\n    #backgroundedPids = new Set();', '    /** All active execution handles, including roots whose descendants hold pipes. */\n    #activeProcesses = new Set();');
  source = section(source, '    /** Kill all backgrounded processes', '    async execute(opts) {', `    /** Compatibility name. Now shuts down foreground and background groups. */
    cleanupBackgrounded(force = false) {
        for (const proc of this.#activeProcesses) {
            if (force) {
                killTree(proc);
                proc._cmFinish?.();
            } else {
                killTree(proc, "SIGTERM");
                if (!proc._cmKillTimer) proc._cmKillTimer = setTimeout(() => {
                    killTree(proc);
                    proc._cmFinish?.();
                }, 250);
            }
        }
    }
`);
  source = replace(source, '        const { language, code, timeout, background = false, cwd: cwdOverride } = opts;', `        const { language, code, background = false, cwd: cwdOverride } = opts;
        if (background && opts.timeout === undefined) throw new Error("background requires an explicit timeout and shutdown ownership");
        const timeout = opts.timeout === undefined ? 120_000 : opts.timeout;
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647)
            throw new Error("timeout must be positive, finite and within the Node timer range");`);
  source = replace(source, 'return await this.#compileAndRun(filePath, tmpDir, timeout);', 'const result = await this.#compileAndRun(filePath, tmpDir, timeout, background);\n                if (!result.backgrounded) cleanupTmpDir(tmpDir);\n                return result;');
  source = section(source, '    async #compileAndRun(srcPath, cwd, timeout) {', '    async #spawn(cmd, cwd, sandboxTmpDir, timeout, background = false) {', `    async #compileAndRun(srcPath, cwd, timeout, background) {
        const binPath = srcPath.replace(/\\.rs$/, "") + (isWin ? ".exe" : "");
        const start = Date.now();
        // Async compile shares execution ownership and a bounded overall budget.
        const compiled = await this.#spawn(["rustc", srcPath, "-o", binPath], cwd, cwd, Math.min(timeout, 60_000));
        if (compiled.exitCode !== 0) return { ...compiled, stderr: "Compilation failed:\\n" + compiled.stderr };
        const remaining = timeout - (Date.now() - start);
        if (remaining <= 0) return { stdout: "", stderr: "Compilation exhausted execution budget", exitCode: 1, timedOut: true };
        return this.#spawn([binPath], cwd, cwd, remaining, background);
    }
`);
  source = replace(source, '            let timedOut = false;\n            let resolved = false;', `            this.#activeProcesses.add(proc);
            proc.once("exit", () => { proc._cmMembers = groupMembers(proc.pid); });
            let timedOut = false;
            let resolved = false;
            let drainTimer;
            const dispose = () => {
                clearTimeout(timer);
                clearTimeout(drainTimer);
                clearTimeout(proc._cmKillTimer);
                this.#activeProcesses.delete(proc);
                proc._cmClosed = true;
                cleanupTmpDir(sandboxTmpDir);
            };
            const stop = () => {
                killTree(proc);
                // A descendant that escaped the group must not hold our pipes forever.
                drainTimer = setTimeout(() => proc._cmFinish(), 300);
            };`);
  source = section(source, '            // Issue #406 — if the caller', '            const timer = timeout === undefined', `            // Local resource policy: execute() always provides a finite deadline.
`);
  source = replace(source, '            const timer = timeout === undefined ? undefined : setTimeout(() => {', '            const timer = setTimeout(() => {');
  source = replace(source, '                    if (proc.pid)\n                        this.#backgroundedPids.add(proc.pid);\n', '');
  source = replace(source, '                    killTree(proc);\n                }\n            }, timeout);', '                    stop();\n                }\n            }, timeout);');
  source = source.replaceAll('                    killTree(proc);\n                }\n            });', '                    stop();\n                }\n            });');
  source = replace(source, '            proc.on("close", (exitCode) => {\n                clearTimeout(timer);', `            const finish = (exitCode) => {
                if (proc._cmClosed) return;
                // If the root closed its streams but left a child, reclaim it now.
                killTree(proc);
                proc.stdout?.destroy();
                proc.stderr?.destroy();
                dispose();`);
  source = replace(source, '            proc.on("error", (err) => {\n                clearTimeout(timer);', '            proc._cmFinish = () => { timedOut = true; finish(1); };\n            proc.on("close", finish);\n            proc.on("error", (err) => {\n                dispose();');
  source = replace(source, '                    timedOut,\n                });\n            });\n            proc._cmFinish', '                    timedOut,\n                });\n            };\n            proc._cmFinish');
  return source;
}
export function server(source) {
  source = section(source, '/**\n * Default execution timeout (ms)', 'export const AGY_DEFAULT_EXEC_TIMEOUT_MS', `/**
 * Pi and Antigravity CLI apply a 120s default at the server layer.
 * The executor also bounds omitted timeouts to 120s on every host.
 * Explicit positive timeouts can extend that budget. Only agy honors
 * CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS.
 */
`);
  source = replace(source, `    // Only agy gets a default — every other host enforces its own RPC timeout, so
    // keep the unbounded behavior there. Detected via the env the agy bundle pins
    // (CONTEXT_MODE_PLATFORM=antigravity-cli). Tunable via CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS.`, '    // Preserve the agy override. Other hosts use the executor default.');
  source = replace(source, '    if (timeout !== undefined)\n        return timeout;', `    if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647)
            throw new Error("timeout must be positive, finite and within the Node timer range");
        return timeout;
    }
    if (detectPlatform().platform === "pi") return 120_000;`);
  const timeoutAnchor = '.coerce.number()\n            .optional()\n            .describe("Max execution time';
  if (source.split(timeoutAnchor).length !== 4) throw new Error('Expected exactly three execution timeout schemas');
  source = source.replaceAll(timeoutAnchor, '.coerce.number().finite().positive().max(2147483647)\n            .optional()\n            .describe("Max execution time');
  if (source.split('.coerce.number().finite().positive().max(2147483647)').length !== 4)
    throw new Error('Execution timeout schema validation failed');
  source = source.replaceAll("When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy).", 'When omitted, execution defaults to 120000ms.');
  source = source.replaceAll("When omitted, no server-side timer fires — the MCP host's RPC timeout governs.", 'When omitted, execution defaults to 120000ms.');
  source = replace(source, 'Keep process running after timeout (for servers/daemons).', 'Requires an explicit positive timeout. The owning bridge reclaims background jobs on shutdown or cancellation. Keep process running after timeout (for servers/daemons).');
  source = replace(source, '}, async ({ language, code, timeout, background, cwd, intent }) => {', `}, async ({ language, code, timeout, background, cwd, intent }) => {
    if (background && timeout === undefined) throw new Error("background requires an explicit timeout and shutdown ownership");`);
  source = replace(source, '    process.on("exit", shutdown);', '    process.on("exit", () => { executor.cleanupBackgrounded(true); shutdown(); });');
  return source;
}
export function lifecycle(source) {
  return replace(source, 'function readGrandparentPpidImpl() {\n    if (process.platform', `function readGrandparentPpidImpl() {
    // Pi's bridge is a direct child, not an npm wrapper. Keep the 1s owner watch.
    if (process.env.CONTEXT_MODE_DIRECT_PARENT === "1") return NaN;
    if (process.platform`);
}
export const transforms = {
  'build/adapters/pi/mcp-bridge.js': bridge,
  'build/executor.js': executor,
  'build/server.js': server,
  'build/lifecycle.js': lifecycle,
};
