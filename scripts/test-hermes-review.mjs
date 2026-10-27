#!/usr/bin/env node
/** Installed Hermes review regression checks for Pi 1.4.0.
 * Run: node scripts/test-hermes-review.mjs
 * Uses only a loopback OpenAI SSE fixture. No live credentials or memory stores.
 * Requires the installed Pi 1.4.0 release and pi-hermes-memory with dependency seams.
 * The main RPC host loads the real review handler. Its fallback loads the full Hermes extension.
 * One fallback runs the full installed Hermes extension through execChildPrompt and its watchdog.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = dirname(dirname(script));
const candidatePath = join(repo, 'pi/.pi/agent/hermes-memory-config.json');
const modelReference = 'ai-model-router/zai-org/GLM-5.3-Flash';
const modelId = 'zai-org/GLM-5.3-Flash';
const fallbackId = 'gpt-6-luna';
const fallbackReference = 'ai-model-router/gpt-6-luna';
const suiteBudgetMs = 90_000;
const caseBudgetMs = 8_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateJson = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function within(promise, description, ms = caseBudgetMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Deadline exceeded: ${description}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, description) {
  const deadline = Date.now() + caseBudgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Deadline exceeded: ${description}`);
}
function childEnv(home, runtime, hermes, root) {
  // Do not forward credentials, proxies, NODE_OPTIONS, or extension markers.
  return {
    HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8',
    TMPDIR: root, XDG_CACHE_HOME: join(root, 'cache'), JITI_CACHE_DIR: join(root, 'jiti'),
    PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    HERMES_TEST_RUNTIME: runtime, HERMES_TEST_PACKAGE: hermes,
    HERMES_TEST_ROOT: root, HERMES_TEST_SOURCE_HOME: homedir(),
  };
}

async function supervise() {
  assert(!process.versions.bun, 'Run with Node, not Bun');
  assert(process.platform !== 'win32', 'This harness needs POSIX process groups');
  const runtime = join(homedir(), '.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent');
  const hermes = join(homedir(), '.pi/agent/npm/node_modules/pi-hermes-memory');
  for (const path of [candidatePath, join(runtime, 'dist/cli.js'), join(hermes, 'src/handlers/background-review.ts')]) {
    assert(existsSync(path), `Missing dependency: ${path}. Install Pi 1.4.0 and pi-hermes-memory before running.`);
  }
  assert.equal(JSON.parse(readFileSync(join(runtime, 'package.json'))).version, '1.4.0', 'This harness pins the Pi 1.4.0 API');
  const before = readFileSync(candidatePath);
  const root = mkdtempSync(join(tmpdir(), 'hermes-review-test-'));
  assert.equal(statSync(root).mode & 0o777, 0o700, 'Temporary root must be private');
  const home = join(root, 'home');
  mkdirSync(join(home, '.pi/agent'), { recursive: true, mode: 0o700 });
  let child;
  let timer;
  let stopped = false;
  const terminate = () => { stopped = true; if (child?.pid) killGroup(child.pid, 'SIGKILL'); };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  try {
    child = spawn(process.execPath, [script, '--isolated'], {
      cwd: root, env: childEnv(home, runtime, hermes, root),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // All output contains synthetic fixtures only. Keep failed startup diagnostics bounded.
    let output = '';
    let diagnostics = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-32_000); });
    child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-8_000); });
    timer = setTimeout(terminate, suiteBudgetMs);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    process.stdout.write(output);
    assert(!stopped, 'Suite exceeded its 90-second budget or was cancelled');
    assert.equal(code, 0, `Isolated suite failed. ${diagnostics.replaceAll(root, '<private-temp>')}`);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    if (child?.pid) {
      killGroup(child.pid, 'SIGKILL');
      await until(() => !alive(-child.pid), 'owned test process group exit');
    }
    // Watchdog children use separate groups. Cover supervisor cancellation too.
    const childAuditLog = join(root, 'rpc-events.jsonl');
    if (existsSync(childAuditLog)) {
      const complete = readFileSync(childAuditLog, 'utf8');
      const events = complete.slice(0, complete.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      for (const event of events.filter((value) => value.type === 'child-ready')) {
        if (alive(event.pid) || alive(-event.pid)) killGroup(event.pid, 'SIGKILL');
        await until(() => !alive(event.pid) && !alive(-event.pid), 'supervisor fallback group cleanup');
      }
    }
    try { assert.deepEqual(readFileSync(candidatePath), before, 'Candidate config changed during testing'); }
    finally {
      rmSync(root, { recursive: true, force: true });
      assert(!existsSync(root), 'Private temporary files remain');
    }
  }
  console.log('PASS cleanup: owned process group and private temporary root removed; candidate config unchanged');
}

async function isolatedSuite() {
  process.umask(0o077);
  const root = process.env.HERMES_TEST_ROOT;
  const runtimePath = process.env.HERMES_TEST_RUNTIME;
  const hermesPath = process.env.HERMES_TEST_PACKAGE;
  assert(root && runtimePath && hermesPath, 'Start this harness without --isolated');
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  assert.deepEqual(candidate, {
    reviewTransport: 'direct', llmModelOverride: modelReference, llmFallbackModels: [fallbackReference], llmThinkingOverride: 'off',
    childExtensionPaths: [join(process.env.HERMES_TEST_SOURCE_HOME, '.pi/agent/extensions/aws-sso-refresh.ts')],
    quickCheckOnOpen: false, sessionRetentionDays: 60,
  }, 'Review config must preserve child extension, quick-check, and retention settings');
  const router = JSON.parse(readFileSync(join(repo, 'pi/.pi/agent/models.json'), 'utf8')).providers?.['ai-model-router'];
  const declaredReviewModel = router?.models?.find((model) => model.id === modelId);
  assert(declaredReviewModel, 'Configured review model must exist in the candidate router catalog');
  assert(router.models.some((model) => model.id === fallbackId), 'Fallback model must exist in the candidate router catalog');
  assert.equal(router.api, 'openai-completions', 'Fixture must use the candidate router protocol');
  assert.equal(router.compat?.supportsReasoningEffort, true, 'Fixture must preserve router thinking support');
  assert.equal(declaredReviewModel.reasoning, true, 'Thinking-off test needs a reasoning-capable model');
  console.log('PASS candidate config: direct GLM Flash, GPT Luna fallback, thinking off and unrelated settings preserved');

  // loadExtensions owns jiti aliases, including pi-ai/compat in the installed host.
  // Never import Hermes TS through a separate loader or duplicate pi-ai package.
  const moduleAt = (path) => import(pathToFileURL(join(runtimePath, path)).href);
  const { loadExtensions } = await moduleAt('dist/core/extensions/loader.js');
  const { ModelRuntime } = await moduleAt('dist/core/model-runtime.js');
  const { ModelRegistry } = await moduleAt('dist/core/model-registry.js');
  const bridgePath = join(root, 'bridge.ts');
  const importPath = (path) => JSON.stringify(join(hermesPath, path));
  writeFileSync(bridgePath, `
import { setupBackgroundReview } from ${importPath('src/handlers/background-review.ts')};
import { runDirectMemoryCompletion, buildDirectReviewCompletionOptions, resolveReviewModels } from ${importPath('src/handlers/review-memory-ops.ts')};
import { MemoryStore } from ${importPath('src/store/memory-store.ts')};
import { loadConfig } from ${importPath('src/config.ts')};
import { execChildPrompt } from ${importPath('src/handlers/pi-child-process.ts')};
export default function (pi) {
  pi.registerTool({ name: 'hermes_test_bridge', label: 'Test bridge', description: 'Local test only',
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [], details: { setupBackgroundReview, runDirectMemoryCompletion,
      buildDirectReviewCompletionOptions, resolveReviewModels, MemoryStore, loadConfig, execChildPrompt } }; }
  });
}
`, { mode: 0o600 });
  const loaded = await loadExtensions([bridgePath], root);
  assert.equal(loaded.errors.length, 0, `Installed Hermes cannot load through Pi: ${JSON.stringify(loaded.errors)}`);
  const api = (await loaded.extensions[0].tools.get('hermes_test_bridge').definition.execute()).details;
  for (const [name, value] of Object.entries(api)) assert.equal(typeof value, 'function', `Installed API missing: ${name}`);
  const config = api.loadConfig(candidatePath);
  assert.equal(config.reviewTransport, candidate.reviewTransport);
  assert.equal(config.llmModelOverride, candidate.llmModelOverride);
  assert.deepEqual(config.llmFallbackModels, [fallbackReference]);
  assert.equal(config.llmThinkingOverride, candidate.llmThinkingOverride);
  assert.deepEqual(config.childExtensionPaths, candidate.childExtensionPaths);
  assert.equal(config.quickCheckOnOpen, false);
  assert.equal(config.sessionRetentionDays, 60);
  console.log(`PASS installed APIs: Pi 1.4.0 jiti aliases, Hermes ${JSON.parse(readFileSync(join(hermesPath, 'package.json'))).version}`);

  const requests = [];
  const sockets = new Set();
  let mode = 'success';
  let fixtureError;
  const preference = 'The user prefers Vitest for new TypeScript projects.';
  const operations = [
    { action: 'add', target: 'user', content: preference },
    { action: 'add', target: 'memory', content: 'Use local fixtures for review tests.' },
    { action: 'add', target: 'project', content: 'Review fixtures live in scripts.' },
    { action: 'add', target: 'failure', content: 'Validate review model references.', category: 'insight' },
  ];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      let bytes = '';
      for await (const chunk of req) { bytes += chunk; assert(bytes.length < 1_000_000, 'Fixture payload too large'); }
      const body = JSON.parse(bytes);
      const record = { body, closed: false };
      requests.push(record);
      res.once('close', () => { record.closed = true; });
      assert(['fixture-active', modelId, fallbackId].includes(body.model), 'Unexpected model reached fixture');
      const isChild = mode === 'real-fallback' && body.tools?.length > 0;
      const responseMode = body.model === 'fixture-active' ? 'active'
        : mode === 'primary-error' ? (body.model === modelId ? 'provider-error' : 'success')
        : isChild ? 'child' : mode === 'real-fallback' ? 'parse-error' : mode;
      if (responseMode === 'provider-error') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic provider failure', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      if (responseMode === 'hang') return; // Closed by the tested AbortSignal or suite cleanup.
      const content = responseMode === 'active' ? 'Fixture assistant reply.'
        : responseMode === 'parse-error' ? 'not an operations payload'
        : responseMode === 'empty-response' ? ''
        : responseMode === 'empty' ? '{"operations":[]}'
        : JSON.stringify({ operations });
      const chunk = (delta, finish_reason = null) => ({
        id: 'hermes-local', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      if (responseMode === 'child') {
        assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ['memory_add', 'memory_remove', 'memory_replace']);
        assert(!('reasoning_effort' in body), 'Fallback child must use thinking off');
        const completed = body.messages.some((message) => message.role === 'tool');
        if (completed) {
          res.write(`data: ${JSON.stringify(chunk({ content: 'HERMES_CHILD_SAVED_VITEST' }))}\n\n`);
          res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'local-memory-add', type: 'function',
            function: { name: 'memory_add', arguments: JSON.stringify({ target: 'user', content: preference }) } }] }))}\n\n`);
          res.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
      // Split content into SSE deltas, exercising the real provider parser.
      const middle = Math.floor(content.length / 2);
      for (const part of [content.slice(0, middle), content.slice(middle)]) {
        res.write(`data: ${JSON.stringify(chunk({ content: part }))}\n\n`);
      }
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { fixtureError = error; res.destroy(); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const modelsPath = join(root, 'models.json');
  const models = { providers: { 'ai-model-router': {
    // Copy only checked protocol metadata, never endpoint, key, headers, or commands.
    baseUrl, api: router.api, apiKey: 'local-fixture-only',
    compat: { supportsReasoningEffort: router.compat.supportsReasoningEffort }, models: [
      { id: modelId, name: 'Review fixture', reasoning: declaredReviewModel.reasoning, input: ['text'], contextWindow: 128000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: fallbackId, name: 'Fallback fixture', reasoning: true, input: ['text'], contextWindow: 128000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: 'fixture-active', name: 'Active fixture', reasoning: true, input: ['text'], contextWindow: 128000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  } } };
  privateJson(modelsPath, models);
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, 'auth.json'),
    modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  assert.equal(registry.getError(), undefined, 'Isolated model configuration failed');
  const active = registry.find('ai-model-router', 'fixture-active');
  const review = registry.find('ai-model-router', modelId);
  const fallback = registry.find('ai-model-router', fallbackId);
  assert(active && review && fallback, 'Fixture models did not load');
  assert.deepEqual(api.resolveReviewModels(active, registry, config), [review, fallback], 'Review must use the configured chain, not the active one');
  const opts = api.buildDirectReviewCompletionOptions(review, { apiKey: 'local-fixture-only' }, 'off', new AbortController().signal, 'test-session');
  assert.equal(opts.reasoning, undefined, 'Thinking off must not request reasoning');
  const high = api.buildDirectReviewCompletionOptions(review, { apiKey: 'local-fixture-only' }, 'high', new AbortController().signal, 'test-session');
  assert.equal(high.reasoning, 'high', 'Positive control: thinking override seam is active');

  let sequence = 0;
  async function newStore(label) {
    const memoryDir = join(root, `memory-${++sequence}-${label}`);
    const store = new api.MemoryStore({ ...config, memoryDir, autoConsolidate: false, memoryOverflowStrategy: 'reject' });
    await store.loadFromDisk();
    return { store, memoryDir };
  }
  async function harness({ direct, child, enabled = true, grace = 1000 } = {}) {
    const global = await newStore('global');
    const project = await newStore('project');
    const handlers = new Map();
    const notifications = [];
    const directCalls = [];
    const childCalls = [];
    const results = [];
    let settled = 0;
    const entries = [];
    const turnAbort = new AbortController();
    const ctx = { cwd: root, model: active, signal: turnAbort.signal, modelRegistry: registry,
      sessionManager: { getBranch: () => entries, getSessionId: () => 'local-review-test' },
      ui: { notify: (message, level) => notifications.push({ message, level }) } };
    const pi = { on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } };
    const emit = async (type, event = {}) => { for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx); };
    api.setupBackgroundReview(pi, global.store, project.store, { ...config, reviewEnabled: enabled,
      nudgeInterval: 3, nudgeToolCalls: 100 }, {
      projectName: 'fixture-project', deps: {
        runDirectReview: async (...args) => {
          directCalls.push(args);
          const result = await (direct ?? api.runDirectMemoryCompletion)(...args);
          results.push(result);
          return result;
        },
        execChildPrompt: async (...args) => { childCalls.push(args); return child ? child(...args) : { code: 0, stdout: 'nothing to save' }; },
        onReviewSettled: () => { settled++; }, shutdownGraceMs: grace,
      },
    });
    async function turn() {
      const user = { role: 'user', content: [{ type: 'text', text: 'Please remember that I prefer Vitest.' }], timestamp: Date.now() };
      const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply.' }], timestamp: Date.now() };
      entries.push({ type: 'message', message: user }, { type: 'message', message: assistant });
      await emit('message_end', { message: user });
      await emit('turn_end', { message: assistant });
    }
    async function trigger() { for (let i = 0; i < 3; i++) await turn(); }
    async function finish() { await until(() => settled > 0, 'background review settled'); assert(!fixtureError, fixtureError?.message); }
    return { ...global, project, emit, turn, trigger, finish, notifications, directCalls, childCalls, results,
      turnAbort, settled: () => settled };
  }
  async function check(name, fn) {
    const h = await harness(fn.options);
    try { await within(fn(h), name); console.log(`PASS ${name}`); }
    finally { await h.emit('session_shutdown'); }
  }
  let rpc;
  try {
    await check('successful direct SSE review writes real isolated stores and preserves existing entries', async (h) => {
      mode = 'success';
      assert((await h.store.add('user', 'Existing preference.')).success);
      await h.turn(); await h.turn();
      assert.equal(h.directCalls.length, 0, 'Do not review before three user turns');
      await h.turn(); await h.finish();
      assert.deepEqual(h.results, [{ ok: true, appliedCount: 4 }]);
      assert.equal(h.childCalls.length, 0);
      assert.deepEqual(h.store.getUserEntries(), ['Existing preference.', preference]);
      assert.deepEqual(h.project.store.getMemoryEntries(), ['Review fixtures live in scripts.']);
      assert.equal(h.store.getAllFailureEntries().length, 1);
      assert.equal(h.store.formatForSystemPrompt().includes(preference), false, 'Frozen snapshot must not mutate');
      const disk = new api.MemoryStore({ ...config, memoryDir: h.memoryDir });
      await disk.loadFromDisk();
      assert.deepEqual(disk.getUserEntries(), h.store.getUserEntries(), 'Verify real disk persistence');
      const body = requests.at(-1).body;
      assert.equal(body.model, modelId);
      assert(!('reasoning_effort' in body), 'Thinking off must not request a reasoning effort');
      assert(!body.tools?.length, 'Direct review must be a side-channel, not a tool-enabled agent');
      assert(body.messages.some((m) => JSON.stringify(m.content).includes('Conversation to Review')));
      assert.equal(h.directCalls[0][3].config.llmThinkingOverride, 'off');
      assert.equal(h.notifications.length, 1);
      assert.equal(h.notifications[0].level, 'info');
    });
    await check('primary model error uses GPT Luna directly before subprocess fallback', async (h) => {
      mode = 'primary-error'; const start = requests.length;
      await h.trigger(); await h.finish();
      assert.deepEqual(requests.slice(start).map((request) => request.body.model), [modelId, fallbackId]);
      assert.equal(h.results[0].ok, true); assert.equal(h.childCalls.length, 0);
      assert(h.store.getUserEntries().includes(preference));
      assert(requests.slice(start).every((request) => !('reasoning_effort' in request.body)));
    });
    for (const failure of ['provider-error', 'parse-error']) {
      await check(`${failure} invokes exactly one subprocess fallback with session signal and preserved config`, async (h) => {
        mode = failure; await h.trigger(); await h.finish();
        assert.equal(h.results[0].ok, false);
        assert.equal(h.results[0].fallbackReason, failure.replace('-', '_'));
        assert.equal(h.childCalls.length, 1);
        const [pi, prompt, passedConfig, options] = h.childCalls[0];
        assert(pi && prompt.includes('Conversation to Review'));
        assert.equal(passedConfig.llmModelOverride, modelReference);
        assert.deepEqual(passedConfig.llmFallbackModels, [fallbackReference]);
        assert.deepEqual(passedConfig.childExtensionPaths, candidate.childExtensionPaths);
        assert.equal(options.timeoutMs, 120000);
        assert.equal(options.cwd, root);
        assert.notEqual(options.signal, h.turnAbort.signal, 'Turn cancellation must not own review');
        assert.equal(h.notifications.length, 0);
        assert.deepEqual(h.store.getUserEntries(), []);
      });
    }
    for (const empty of ['empty', 'empty-response']) {
      await check(`${empty} settles without fallback, memory writes, or notifications`, async (h) => {
        mode = empty; await h.trigger(); await h.finish();
        assert.equal(h.results[0].ok, true);
        assert.equal(h.results[0].appliedCount, 0);
        assert.equal(h.childCalls.length, 0);
        assert.equal(h.notifications.length, 0);
        assert.deepEqual(h.store.getUserEntries(), []);
        assert(!existsSync(join(h.memoryDir, 'USER.md')));
      });
    }
    for (const reason of ['empty', 'aborted']) {
      const fn = async (h) => {
        await h.trigger(); await h.finish();
        assert.equal(h.childCalls.length, 0);
        assert.equal(h.notifications.length, 0);
      };
      fn.options = { direct: async () => ({ ok: false, appliedCount: 0, fallbackReason: reason }) };
      await check(`handler declines fallback for ${reason} result`, fn);
    }
    const throwing = async (h) => {
      await h.trigger(); await h.finish(); assert.equal(h.childCalls.length, 1);
      assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].level, 'warning');
      assert(h.notifications[0].message.includes('Synthetic direct exception'));
      assert(h.notifications[0].message.includes('Synthetic child failure'));
    };
    throwing.options = { direct: async () => { throw new Error('Synthetic direct exception'); },
      child: async () => ({ code: 1, stderr: 'Synthetic child failure' }) };
    await check('thrown direct error and failed fallback produce one diagnostic warning', throwing);
    await check('shutdown aborts real direct SSE work, clears in-flight state, and prevents later review', async (h) => {
      mode = 'hang'; const count = requests.length;
      await h.trigger(); await until(() => requests.length > count, 'hung review request');
      h.turnAbort.abort();
      await h.emit('turn_end', { message: { role: 'assistant', content: [] } });
      assert.equal(h.directCalls.length, 1, 'In-flight review must not overlap');
      assert.equal(h.directCalls[0][3].signal.aborted, false, 'Turn abort must not cancel review');
      await h.emit('session_shutdown'); await h.finish();
      assert.equal(h.results[0].fallbackReason, 'aborted');
      assert.equal(h.directCalls[0][3].signal.aborted, true);
      assert.equal(h.childCalls.length, 0); assert.equal(h.notifications.length, 0);
      await until(() => requests.at(-1).closed, 'SSE abort closes socket');
      await h.trigger(); assert.equal(h.directCalls.length, 1);
      assert.deepEqual(h.store.getUserEntries(), []);
    });
    const childCancellation = async (h) => {
      await h.trigger();
      await until(() => h.childCalls.length === 1, 'fallback starts');
      const signal = h.childCalls[0][3].signal;
      assert.equal(signal.aborted, false);
      await h.emit('session_shutdown'); await h.finish();
      assert.equal(signal.aborted, true);
      assert.equal(h.notifications.length, 0, 'Shutdown must suppress fallback notifications');
      assert.deepEqual(h.store.getUserEntries(), []);
    };
    childCancellation.options = {
      direct: async () => ({ ok: false, appliedCount: 0, fallbackReason: 'provider_error' }),
      child: async (_pi, _prompt, _config, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ code: 1, stderr: 'Synthetic cancellation' }), { once: true });
      }),
    };
    await check('shutdown cancels the subprocess seam without late notifications', childCancellation);
    let releaseUncooperative;
    const boundedShutdown = async (h) => {
      await h.trigger(); await until(() => h.directCalls.length === 1, 'uncooperative review starts');
      try {
        await within(h.emit('session_shutdown'), 'bounded shutdown grace', 1000);
        assert.equal(h.directCalls[0][3].signal.aborted, true);
        assert.equal(h.settled(), 0, 'Review is still pending when shutdown grace expires');
      } finally { releaseUncooperative({ ok: true, appliedCount: 1 }); }
      await h.finish();
      assert.equal(h.notifications.length, 0, 'Late direct results must not notify after shutdown');
      assert.equal(h.childCalls.length, 0);
    };
    boundedShutdown.options = { grace: 20, direct: async () => new Promise((resolve) => { releaseUncooperative = resolve; }) };
    await check('shutdown wait remains bounded when direct dependency ignores cancellation', boundedShutdown);
    const disabled = async (h) => { await h.trigger(); assert.equal(h.directCalls.length, 0); assert.equal(h.childCalls.length, 0); };
    disabled.options = { enabled: false };
    await check('disabled review does not call either transport', disabled);

    // Real RPC lifecycle with real ExtensionContext, SessionManager and ModelRegistry.
    // Only test-owned setup is loaded. No other extensions, skills, MCP, or credentials.
    const agentDir = join(root, 'rpc-agent');
    const rpcHome = join(root, 'rpc-home');
    mkdirSync(agentDir, { mode: 0o700 }); mkdirSync(rpcHome, { mode: 0o700 });
    const hostMemory = join(root, 'rpc-memory');
    privateJson(join(agentDir, 'models.json'), models);
    privateJson(join(agentDir, 'settings.json'), { packages: [], cacheWarming: 'off', compaction: { enabled: false },
      retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false, defaultProjectTrust: 'never' });
    privateJson(join(agentDir, 'hermes-memory-config.json'), { ...candidate, memoryDir: hostMemory });
    const eventsPath = join(root, 'rpc-events.jsonl');
    const childAgent = join(root, 'child-agent');
    const childMemory = join(root, 'child-memory');
    const childAudit = join(root, 'child-audit.ts');
    const bin = join(root, 'bin');
    mkdirSync(childAgent, { mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
    privateJson(join(childAgent, 'models.json'), models);
    privateJson(join(childAgent, 'settings.json'), { packages: [], cacheWarming: 'off', compaction: { enabled: false },
      retry: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false, defaultProjectTrust: 'never' });
    privateJson(join(childAgent, 'hermes-memory-config.json'), { ...candidate, childExtensionPaths: [childAudit],
      memoryDir: childMemory, reviewEnabled: false, correctionDetection: false,
      flushOnShutdown: false, flushOnCompact: false, autoConsolidate: false, standingInstructionsEnabled: false });
    writeFileSync(childAudit, `import fs from 'node:fs'; export default function(pi) {
      pi.on('session_start', () => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ type: 'child-ready',
        pid: process.pid, memoryChild: process.env.PI_HERMES_MEMORY_CHILD, tools: pi.getActiveTools() }) + '\\n'));
    }`, { mode: 0o600 });
    // Resolve the helper's production "pi" command to this release, with private child config.
    const quote = (value) => "'" + String(value).replaceAll("'", "'\\\\''") + "'";
    writeFileSync(join(bin, 'pi'), `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${quote(childAgent)}\nexec ${quote(process.execPath)} ${quote(join(runtimePath, 'dist/cli.js'))} --offline --no-context-files --no-skills --no-prompt-templates --no-mcp --no-approve "$@"\n`, { mode: 0o700 });
    const hostExtension = join(root, 'rpc-review.ts');
    writeFileSync(hostExtension, `
import fs from 'node:fs';
import { setupBackgroundReview } from ${importPath('src/handlers/background-review.ts')};
import { execChildPrompt } from ${importPath('src/handlers/pi-child-process.ts')};
import { MemoryStore } from ${importPath('src/store/memory-store.ts')};
import { loadConfig } from ${importPath('src/config.ts')};
const record = (value) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + '\\n', { mode: 0o600 });
export default async function (pi) {
  const config = loadConfig();
  const store = new MemoryStore(config);
  await store.loadFromDisk();
  let realFallback = false;
  pi.registerCommand('hermes-real-fallback', { description: 'Local fixture only', handler: async () => { realFallback = true; } });
  setupBackgroundReview(pi, store, null, { ...config, nudgeInterval: 3, nudgeToolCalls: 100 }, { deps: {
    execChildPrompt: async (_pi, prompt, passedConfig, options) => {
      if (!realFallback) { record({ type: 'unexpected-fallback' }); return { code: 1 }; }
      const result = await execChildPrompt({ exec: async (command, args, execOptions) => {
        record({ type: 'watchdog', command, args, timeout: execOptions.timeout });
        return pi.exec(command, args, execOptions);
      } }, prompt, { ...passedConfig, childExtensionPaths: [${JSON.stringify(childAudit)}] }, { ...options, timeoutMs: 10000 });
      record({ type: 'child-result', code: result.code, completed: result.stdout?.includes('HERMES_CHILD_SAVED_VITEST'),
        stderr: result.code ? result.stderr?.slice(-1000) : undefined });
      return result;
    },
    onReviewSettled: () => record({ type: 'review-settled', users: store.getUserEntries() }),
  } });
  pi.on('session_start', (_event, ctx) => record({ type: 'ready', mode: ctx.mode,
    model: config.llmModelOverride, thinking: config.llmThinkingOverride, transport: config.reviewTransport }));
  pi.on('session_shutdown', () => record({ type: 'shutdown' }));
}
`, { mode: 0o600 });
    rpc = spawn(process.execPath, [join(runtimePath, 'dist/cli.js'), '--offline', '--mode', 'rpc', '--no-session',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp',
      '--no-themes', '--no-tools', '--no-approve', '--provider', 'ai-model-router', '--model', 'fixture-active',
      '--thinking', 'high', '-e', hostExtension], {
      cwd: root, env: { ...childEnv(rpcHome, runtimePath, hermesPath, root), PI_CODING_AGENT_DIR: agentDir,
        PATH: bin + ':' + (process.env.PATH ?? '/usr/bin:/bin') },
      // Keep the RPC host in the suite's group, so the supervisor owns descendants.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = ''; let stderr = ''; let protocolError;
    const records = [];
    rpc.stdout.setEncoding('utf8'); rpc.stderr.setEncoding('utf8');
    rpc.stdout.on('data', (chunk) => {
      pending += chunk;
      assert(pending.length < 1_000_000, 'RPC buffer limit');
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
        if (!line) continue;
        try { records.push(JSON.parse(line)); } catch { protocolError = new Error('Invalid RPC JSONL record'); }
      }
    });
    rpc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    const close = once(rpc, 'close');
    const hostEvents = () => existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : [];
    let rpcSeq = 0;
    async function command(value) {
      const id = `test-${++rpcSeq}`;
      rpc.stdin.write(JSON.stringify({ id, ...value }) + '\n');
      await until(() => records.some((r) => r.id === id), `RPC ${value.type}`);
      const response = records.find((r) => r.id === id);
      assert.equal(response.success, true, `RPC ${value.type} failed: ${response.error}`);
      return response;
    }
    async function prompt() {
      const count = records.filter((r) => r.type === 'agent_settled').length;
      await command({ type: 'prompt', message: 'Synthetic preference: please remember Vitest.' });
      await until(() => records.filter((r) => r.type === 'agent_settled').length > count, 'real RPC turn settles');
      assert(!records.some((r) => r.type === 'extension_error'), 'RPC extension handler error');
      assert(!records.some((r) => r.type === 'message_end' && ['error', 'aborted'].includes(r.message?.stopReason)), 'RPC provider failed');
    }
    await until(() => hostEvents().some((e) => e.type === 'ready'), 'real RPC startup');
    assert.deepEqual(hostEvents()[0], { type: 'ready', mode: 'rpc', model: modelReference, thinking: 'off', transport: 'direct' });
    const state = (await command({ type: 'get_state' })).data;
    assert.equal(state.model.id, 'fixture-active'); assert.equal(state.thinkingLevel, 'high');
    mode = 'success'; const rpcStart = requests.length;
    await prompt(); await prompt(); await prompt();
    await until(() => hostEvents().some((e) => e.type === 'review-settled'), 'real RPC review settles');
    const hostRequests = requests.slice(rpcStart);
    const hostReview = hostRequests.filter((r) => r.body.model === modelId);
    assert.equal(hostReview.length, 1);
    assert(!('reasoning_effort' in hostReview[0].body), 'RPC direct review must use thinking off');
    assert(hostRequests.filter((r) => r.body.model === 'fixture-active').every((r) => r.body.reasoning_effort === 'high'),
      'Positive control: active host requests must retain high thinking');
    assert(hostEvents().find((e) => e.type === 'review-settled').users.includes(preference));
    assert(readFileSync(join(hostMemory, 'USER.md'), 'utf8').includes(preference));
    assert.equal(records.filter((r) => r.type === 'extension_ui_request' && r.method === 'notify').length, 1);
    const beforeAbort = readFileSync(join(hostMemory, 'USER.md'));
    mode = 'hang'; const hangingStart = requests.length;
    await prompt(); await prompt(); await prompt();
    await until(() => requests.slice(hangingStart).some((r) => r.body.model === modelId), 'RPC shutdown review request');
    const hung = requests.slice(hangingStart).find((r) => r.body.model === modelId);
    await command({ type: 'new_session' }); // Real awaited session_shutdown event.
    await until(() => hung.closed, 'real RPC shutdown cancels SSE');
    assert.equal(hostEvents().filter((e) => e.type === 'review-settled').length, 2);
    assert.equal(hostEvents().filter((e) => e.type === 'shutdown').length, 1);
    assert(!hostEvents().some((e) => e.type === 'unexpected-fallback'));
    assert.deepEqual(readFileSync(join(hostMemory, 'USER.md')), beforeAbort, 'Shutdown must not write late operations');
    await command({ type: 'prompt', message: '/hermes-real-fallback' });
    mode = 'real-fallback'; const fallbackStart = requests.length;
    await prompt(); await prompt(); await prompt();
    await within((async () => {
      while (!hostEvents().some((event) => event.type === 'child-result')) await sleep(20);
    })(), 'actual execChildPrompt fallback', 15_000);
    const childResult = hostEvents().find((event) => event.type === 'child-result');
    assert.equal(childResult.code, 0, `Actual fallback failed: ${childResult.stderr}`);
    assert.equal(childResult.completed, true, 'Check final completion, not exit code alone');
    assert(readFileSync(join(childMemory, 'USER.md'), 'utf8').includes(preference), 'Actual memory_add must persist');
    const childReady = hostEvents().find((event) => event.type === 'child-ready');
    assert(childReady, 'Full child host did not start');
    assert.equal(childReady.memoryChild, '1', 'Production watchdog must set the memory-child marker');
    assert.deepEqual(childReady.tools.sort(), ['memory_add', 'memory_remove', 'memory_replace']);
    const watchdog = hostEvents().find((event) => event.type === 'watchdog');
    assert(watchdog.args[0].endsWith('/child-process-watchdog.mjs'));
    assert.equal(watchdog.args[1], '10000'); assert.equal(watchdog.timeout, 15000);
    assert(watchdog.args.includes(join(hermesPath, 'src/index.ts')), 'Helper must load actual full Hermes');
    assert.deepEqual(watchdog.args.flatMap((arg, index) => arg === '-e' ? [watchdog.args[index + 1]] : []),
      [join(hermesPath, 'src/index.ts'), childAudit], 'Child must not load live auth adapters or other extensions');
    assert.equal(watchdog.args[watchdog.args.indexOf('--tools') + 1], 'memory_add,memory_replace,memory_remove');
    assert.equal(watchdog.args[watchdog.args.indexOf('--exclude-tools') + 1], 'mcp__*');
    assert(!existsSync(dirname(watchdog.args[2])), 'Helper prompt and cancel directory must be removed');
    await until(() => !alive(childReady.pid) && !alive(-childReady.pid), 'actual fallback child group exit');
    assert.deepEqual(requests.slice(fallbackStart).filter((request) => !request.body.tools?.length && request.body.model !== 'fixture-active').map((request) => request.body.model), [modelId, fallbackId]);
    assert.equal(requests.slice(fallbackStart).filter((request) => request.body.tools?.length).length, 2);
    const toolReply = requests.slice(fallbackStart).find((request) => request.body.messages.some((message) => message.role === 'tool'));
    assert(toolReply.body.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('Entry added.')),
      'Child must receive a successful memory_add result before its final completion');
    assert(!readdirSync(root).some((name) => name.startsWith('pi-hermes-prompt-')));
    console.log('PASS actual execChildPrompt fallback: direct parse failure, production watchdog, full Hermes memory-only child, persisted preference and completion');
    rpc.stdin.end();
    const [exit] = await within(close, 'RPC orderly stdin shutdown');
    assert.equal(exit, 0, `RPC host failed: ${stderr}`);
    assert(!alive(rpc.pid), 'RPC host remains alive');
    assert(!protocolError, protocolError?.message);
    assert(!fixtureError, fixtureError?.message);
    assert(!/Failed to load extension|Unhandled|TypeError:/.test(stderr), 'RPC startup diagnostics contain an error');
    console.log('PASS real Pi RPC: nine turns, configured review model/thinking, isolated writes, awaited shutdown cancellation');
    console.log('LIMITS local SSE only; no remote GLM quality/latency claim; fallback succeeds through the real watchdog, timeout/cancel kill behavior remains seam-tested');
  } finally {
    if (rpc && alive(rpc.pid)) {
      rpc.kill('SIGKILL');
      await until(() => !alive(rpc.pid), 'RPC cleanup');
    }
    // The production watchdog gives its Pi child a separate process group.
    // On a failed assertion, let its 10-second deadline settle, then remove only
    // a PID recorded by the test-owned child audit extension if it remains.
    const auditPath = join(root, 'rpc-events.jsonl');
    const ownedChildren = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((event) => event.type === 'child-ready').map((event) => event.pid) : [];
    for (const pid of ownedChildren) {
      try { await within((async () => { while (alive(pid) || alive(-pid)) await sleep(20); })(), 'watchdog child deadline cleanup', 12_000); }
      catch { killGroup(pid, 'SIGKILL'); await until(() => !alive(pid) && !alive(-pid), 'fallback group cleanup'); }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(server.listening, false, 'Loopback server remains open');
    await until(() => sockets.size === 0, 'fixture socket close events');
  }
}

try {
  if (process.argv.includes('--isolated')) await isolatedSuite();
  else await supervise();
} catch (error) {
  console.error(`FAIL Hermes review: ${error.message}`);
  process.exitCode = 1;
}
