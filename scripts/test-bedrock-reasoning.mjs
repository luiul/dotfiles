#!/usr/bin/env node
/** Inspect actual Pi Bedrock payloads before transport. No credentials or network calls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
assert.equal(version, '1.6.0', 'Reverify native serialization before using another runtime');
const modules = join(homedir(), '.pi/agent/install/releases', version, 'node_modules');
const coding = join(modules, '@earendil-works/pi-coding-agent/dist/index.js');
const { createJiti } = await import(pathToFileURL(join(modules, 'jiti/lib/jiti.mjs')).href);
const load = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': coding } });
const { default: extension } = await load.import(resolve('pi/.pi/agent/extensions/bedrock-openai-reasoning.ts'));
const { stream } = await import(pathToFileURL(join(modules, '@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js')).href);
const model = { id: 'openai.gpt-5.6-luna', name: 'Fixture GPT', provider: 'amazon-bedrock', api: 'bedrock-converse-stream', baseUrl: 'http://127.0.0.1:1', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
for (const [level, effort] of Object.entries({ minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })) {
  let payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await stream(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, { reasoning: level, signal: controller.signal, env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: '' }, onPayload(value) { payload = value; throw Error('FIXTURE_BEFORE_TRANSPORT'); } }).result();
    assert.equal(payload?.additionalModelRequestFields?.reasoning?.effort, effort);
  } finally { clearTimeout(timer); }
  pass('native Bedrock maps ' + level + ' to ' + effort);
}
for (const [selected, options, expected] of [[model, {}, undefined], [{ ...model, thinkingLevelMap: { high: 'provider-custom-effort' } }, { reasoning: 'high' }, 'provider-custom-effort']]) {
  let payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await stream(selected, { messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }, { ...options, signal: controller.signal, env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: '' }, onPayload(value) { payload = value; throw Error('FIXTURE_BEFORE_TRANSPORT'); } }).result();
    assert.equal(payload?.additionalModelRequestFields?.reasoning?.effort, expected);
  } finally { clearTimeout(timer); }
}
pass('native off omits reasoning and custom model effort remains native-owned');
const handlers = new Map();
extension({ on(name, handler) { handlers.set(name, handler); } });
const startup = (selected, level) => handlers.get('session_start')({}, { model: selected, thinkingLevel: level });
const rewrite = payload => handlers.get('before_provider_request')({ payload });
for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
  startup(model, level);
  const payload = { additionalModelRequestFields: { reasoning: { effort: 'native-mapping' } } };
  assert.equal(rewrite(payload), undefined, 'Native payload should not be replaced');
}
pass('non-off thinking preserves native serialization and model mappings');
startup(model, 'off');
const input = { other: 1, additionalModelRequestFields: { keep: true, reasoning: { keepReason: true } } };
const output = rewrite(input);
assert.deepEqual(output, { other: 1, additionalModelRequestFields: { keep: true, reasoning: { keepReason: true, effort: 'none' } } });
assert.equal(input.additionalModelRequestFields.reasoning.effort, undefined);
pass('off preserves legacy none request without mutating source');
for (const selected of [{ ...model, provider: 'ai-model-router', api: 'openai-completions' }, { ...model, id: 'anthropic.claude-opus' }, undefined]) {
  startup(selected, 'off');
  assert.equal(rewrite(input), undefined);
}
pass('other models and transports stay untouched');
startup(model, 'off');
handlers.get('thinking_level_select')({ level: 'high' });
assert.equal(rewrite(input), undefined);
handlers.get('model_select')({ model: { ...model, provider: 'ai-model-router', api: 'openai-completions' } });
handlers.get('thinking_level_select')({ level: 'off' });
assert.equal(rewrite(input), undefined);
pass('model and thinking changes update plain state without stale context reads');
for (const payload of [null, [], 'text']) { startup(model, 'off'); assert.equal(rewrite(payload), undefined); }
pass('invalid payloads remain untouched');
console.log(`ALL PASS (${checks} checks), Pi ${version}, no transport request`);
