/** Local prompt-expansion fixture. It has no tools and never contacts Orca or a model API. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';

export default function fixture(pi: ExtensionAPI) {
  const log = (type: string, data = {}) => appendFileSync(process.env.ORCA_PROMPT_EVENTS!, JSON.stringify({ type, ...data }) + '\n');
  let calls = 0;
  pi.registerProvider('orca-prompt-fixture', {
    api: 'orca-prompt-fixture-stream', baseUrl: 'http://local.invalid', apiKey: 'fixture',
    models: [{ id: 'fixture', name: 'Prompt Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      calls++;
      const user = context.messages.findLast(m => m.role === 'user');
      const prompt = typeof user?.content === 'string' ? user.content : user?.content?.filter(p => p.type === 'text').map(p => p.text).join('') ?? '';
      log('model-call', { calls, prompt });
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const text = `ORCA_PROMPT_EXPANDED_${calls}`;
        stream.push({ type: 'start', partial: message });
        message.content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        message.content[0] = { type: 'text', text };
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on('session_start', (_event, ctx) => log('ready', { pid: process.pid, commands: pi.getCommands(), tools: pi.getActiveTools(), mode: ctx.mode }));
  pi.on('input', event => { log('input', { text: event.text }); });
  pi.on('before_agent_start', event => log('expanded', { prompt: event.prompt }));
  pi.on('agent_settled', () => log('settled'));
  pi.on('session_shutdown', event => log('shutdown', { reason: event.reason }));
}
