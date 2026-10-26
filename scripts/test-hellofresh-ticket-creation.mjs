#!/usr/bin/env node
// Offline checks for central ticket intake. No Jira, Slack, or model network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const home = os.homedir();
const agentDir = path.join(home, '.pi/agent');
const host = path.join(agentDir, 'install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent');
const central = path.join(home, 'projects/hellofresh');
const childRepo = path.join(central, 'tardis-community');
const skillPath = path.join(home, 'pi-skills/global/create-hellofresh-ticket/SKILL.md');
const settingsPath = path.join(root, 'hellofresh/projects/hellofresh/.pi/settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
assert.deepEqual(settings.packages, [{ source: 'npm:pi-hermes-memory', extensions: [] }]);
const blackholePath = path.join(root, 'hellofresh/projects/hellofresh/.pi/pi-blackhole-config.json');
assert.deepEqual(JSON.parse(fs.readFileSync(blackholePath, 'utf8')), { memory: false });
const skill = fs.readFileSync(skillPath, 'utf8');
for (const rule of ['Wait for explicit approval', 'In draft-only mode, stop here', '--points', '--impact', '--estimate', 'customfield_10005', 'Do not retry creation', 'Do not save request details', 'The implementation agent owns', 'Markdown, not Jira wiki markup', 'Before any create call', 'harvest.jira.markdown_to_adf', 'Inspect `fields.description` ADF', 'Matching words or round-tripping plain text is not proof of formatting']) {
  assert.ok(skill.includes(rule), `Missing skill rule: ${rule}`);
}
assert.equal(fs.realpathSync(path.join(home, 'pi-skills/pi-native/create-hellofresh-ticket/SKILL.md')), fs.realpathSync(skillPath));
const backfill = fs.readFileSync(path.join(home, 'pi-skills/projects/projects/backfill-hellofresh-pr-business-impact/SKILL.md'), 'utf8');
assert.ok(!backfill.includes('ticket-manager'));
assert.ok(backfill.includes('Harvest is the source of truth for all six impact fields'));
assert.ok(backfill.includes('four-field Business Impact projection'));
console.log('PASS config, native skill link, required instruction text, impact guidance');

// Run the real Harvest formatter, not a mock or text-only LLM fixture.
const rendered = spawnSync('uv', ['run', '--project', path.join(home, 'projects/personal/harvest'), 'python', '-c', `
import json
from harvest.jira import markdown_to_adf
body = '## Scope\\n- Check \\x60recipe_table\\x60\\n\\n## Acceptance Criteria\\n- Data is current\\n\\n## Sources\\n- https://example.com/source'
good = markdown_to_adf(body)
bad = markdown_to_adf('h2. Scope\\n* Check \\x60recipe_table\\x60')
print(json.dumps({'good': good, 'bad': bad}))
`], { encoding: 'utf8', timeout: 30000 });
assert.equal(rendered.status, 0, rendered.stderr || rendered.error?.message);
const adf = JSON.parse(rendered.stdout);
assert.deepEqual(adf.good.content.map(n => n.type), ['heading', 'bulletList', 'heading', 'bulletList', 'heading', 'bulletList']);
assert.deepEqual(adf.good.content.filter(n => n.type === 'heading').map(n => n.attrs.level), [2, 2, 2]);
assert.ok(adf.good.content[1].content[0].content[0].content.some(n => n.text === 'recipe_table' && n.marks?.some(m => m.type === 'code')));
assert.deepEqual(adf.bad.content.map(n => n.type), ['paragraph', 'paragraph']);
assert.equal(adf.bad.content[0].content[0].text, 'h2. Scope');
assert.equal(adf.bad.content[1].content[0].text, '* Check ');
console.log('PASS real Harvest formatter: Markdown creates heading/list nodes; Jira wiki markup does not');

// Use real settings/package resolution against a disposable agent directory.
// Only Hermes is loaded here, without binding session events or opening a store.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-intake-test-'));
const fakeAgent = path.join(temp, 'agent');
const fakeCentral = path.join(temp, 'hellofresh');
const fakeChild = path.join(fakeCentral, 'repo');
fs.mkdirSync(fakeAgent, { recursive: true });
fs.mkdirSync(path.join(fakeCentral, '.pi'), { recursive: true });
fs.mkdirSync(fakeChild);
fs.symlinkSync(path.join(agentDir, 'npm'), path.join(fakeAgent, 'npm'));
fs.symlinkSync(path.join(home, 'pi-skills/pi-native'), path.join(fakeAgent, 'skills'));
fs.writeFileSync(path.join(fakeAgent, 'settings.json'), JSON.stringify({ packages: ['npm:pi-hermes-memory'] }));
fs.copyFileSync(settingsPath, path.join(fakeCentral, '.pi/settings.json'));
const { DefaultResourceLoader, SettingsManager } = await import(path.join(host, 'dist/index.js'));
let activeChild;
const pids = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const groupAlive = pgid => {
  try { process.kill(-pgid, 0); return true; }
  catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code !== 'EPERM') throw e;
    // macOS can return EPERM for an empty group. Confirm membership before deciding.
    const snapshot = spawnSync('/bin/ps', ['-axo', 'pgid='], { encoding: 'utf8', timeout: 5000 });
    assert.equal(snapshot.status, 0, snapshot.stderr || snapshot.error?.message);
    if (!snapshot.stdout.split(/\s+/).some(value => Number(value) === pgid)) return false;
    throw e; // A live group we cannot inspect safely must fail the cleanup check.
  }
};
async function resources(cwd, trusted) {
  const manager = SettingsManager.create(cwd, fakeAgent, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({ cwd, agentDir: fakeAgent, settingsManager: manager });
  await loader.reload({ resolveProjectTrust: async () => trusted });
  const result = loader.getExtensions();
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  return { hermes: result.extensions.some(e => e.path.includes('pi-hermes-memory')), skills: loader.getSkills() };
}

// The fixture reports actual registrations. It never executes a ticket tool.
const probe = path.join(temp, 'probe.ts');
fs.writeFileSync(probe, `
import fs from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { loadUnifiedConfig } from ${JSON.stringify(path.join(agentDir, 'npm/node_modules/pi-blackhole/src/core/unified-config.ts'))};
export default function(pi) {
  pi.registerCommand('ticket-intake-probe', {
    description: 'Offline ticket intake registration check',
    handler(_args, ctx) {
      fs.writeFileSync(process.env.TICKET_INTAKE_REPORT, JSON.stringify({ cwd: ctx.cwd, tools: pi.getAllTools().map(t => t.name), commands: pi.getCommands().map(c => c.name), blackholeMemory: loadUnifiedConfig(ctx.cwd).memory }));
    }
  });
  pi.registerProvider('ticket-intake-fixture', {
    api: 'ticket-intake-fixture', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const user = [...context.messages].reverse().find(m => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : (user?.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
      if (text.includes('draft-only fixture')) {
        for (const expected of ['Wait for explicit approval', 'harvest create ticket', 'Acceptance Criteria']) {
          if (!text.includes(expected)) throw new Error('Skill command did not expand: ' + expected);
        }
      }
      const stream = createAssistantMessageEventStream();
      const message = { role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(), content: [{type:'text',text:'Draft fixture only. Await approval. No ticket created.'}], usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending' };
      queueMicrotask(() => {
        stream.push({type:'start',partial:message});
        stream.push({type:'text_start',contentIndex:0,partial:message});
        stream.push({type:'text_delta',contentIndex:0,delta:message.content[0].text,partial:message});
        stream.push({type:'text_end',contentIndex:0,content:message.content[0].text,partial:message});
        message.stopReason='stop'; stream.push({type:'done',reason:'stop',message}); stream.end();
      });
      return stream;
    }
  });
}
`);
async function live(cwd, expectHermes, promptSkill) {
  const report = path.join(temp, expectHermes ? 'repo-report.json' : 'central-report.json');
  const env = { ...process.env, PWD: cwd, PI_OFFLINE: '1', TICKET_INTAKE_REPORT: report, CONTEXT_MODE_BRIDGE_DEPTH: '0' };
  delete env.PI_WORKSPACE_DIR; delete env.PI_PROJECT_DIR; delete env.CONTEXT_MODE_PROJECT_DIR;
  delete env.JIRA_API_TOKEN; delete env.JIRA_EMAIL;
  const child = spawn(process.execPath, [path.join(host, 'dist/cli.js'), '--offline', '--approve', '--no-session', '--mode', 'rpc', '-e', probe, '--provider', 'ticket-intake-fixture', '--model', 'fixture', '--thinking', 'off'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  activeChild = child; pids.push(child.pid);
  const records = [];
  let buffer = '', stderr = '';
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.trim()) records.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-12000); });
  const wait = async (condition, label, ms = 45000) => {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end && child.exitCode === null && child.signalCode === null) await delay(50);
    assert.ok(condition(), `${label} failed: ${stderr}`);
  };
  const send = (id, type, extra = {}) => child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
  try {
    send('ready', 'get_state');
    await wait(() => records.some(r => r.type === 'response' && r.id === 'ready' && r.success), 'RPC startup');
    send('inspect', 'prompt', { message: '/ticket-intake-probe' });
    await wait(() => fs.existsSync(report), 'registration report');
    const actual = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(actual.cwd, cwd);
    assert.equal(actual.blackholeMemory, expectHermes, 'Blackhole memory workspace toggle');
    for (const name of ['memory_add', 'memory_replace', 'memory_remove', 'memory_search', 'session_search', 'skill_manage']) assert.equal(actual.tools.includes(name), expectHermes, name);
    assert.ok(actual.commands.includes('skill:create-hellofresh-ticket'), 'Native creation skill unavailable');
    // Context Mode registers its bridge tools lazily. Its commands prove loading before first use.
    assert.ok(actual.commands.includes('ctx-stats') && actual.commands.includes('ctx-doctor'), 'Context Mode disabled unexpectedly');
    if (promptSkill) {
      // Exercise enough turns to cross both review/flush user-message thresholds.
      // The local model asserts expansion and emits text only, never tool calls.
      for (let n = 0; n < 6; n++) {
        const prior = records.filter(r => r.type === 'agent_settled').length;
        send(`draft-${n}`, 'prompt', { message: '/skill:create-hellofresh-ticket draft-only fixture, do not create a ticket.' });
        await wait(() => records.filter(r => r.type === 'agent_settled').length > prior, 'skill settlement', 15000);
      }
      assert.equal(records.filter(r => r.type === 'tool_execution_start').length, 0, 'Draft smoke executed a tool');
      assert.ok(records.filter(r => r.type === 'message_end' && r.message?.role === 'assistant').every(r => r.message.stopReason === 'stop'), 'Fixture model failed');
    }
    assert.equal(records.filter(r => r.type === 'extension_error').length, 0, JSON.stringify(records.filter(r => r.type === 'extension_error')));
    console.log(`PASS real Pi ${expectHermes ? 'implementation repo: Hermes enabled' : 'central intake: Hermes absent, native skill and Context Mode present, six skill expansion turns'}`);
  } finally {
    child.stdin.end();
    const end = Date.now() + 10000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(50);
    // Descendants can keep the group alive after Pi exits. Check it independently.
    if (groupAlive(child.pid)) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    const killEnd = Date.now() + 2000;
    while (groupAlive(child.pid) && Date.now() < killEnd) await delay(50);
    if (groupAlive(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    const finalEnd = Date.now() + 2000;
    while (groupAlive(child.pid) && Date.now() < finalEnd) await delay(50);
    assert.equal(alive(child.pid), false, 'Test host survived shutdown');
    assert.equal(groupAlive(child.pid), false, 'Test-owned process group survived shutdown');
    activeChild = undefined;
  }
}
const bound = setTimeout(() => { if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} } }, 160000);
try {
  const trusted = await resources(fakeCentral, true);
  assert.equal(trusted.hermes, false);
  assert.ok(trusted.skills.skills.some(s => s.name === 'create-hellofresh-ticket'));
  assert.equal((await resources(fakeCentral, false)).hermes, true, 'Untrusted project settings should be skipped');
  assert.equal((await resources(fakeChild, true)).hermes, true, 'Parent override leaked into child');
  const unrelated = path.join(temp, 'unrelated');
  fs.mkdirSync(unrelated);
  assert.ok((await resources(unrelated, true)).skills.skills.some(s => s.name === 'create-hellofresh-ticket'), 'Global skill missing outside HelloFresh');
  console.log('PASS real resource loader: trusted central off, untrusted central on, child repo on, global skill available elsewhere');
  // Import through Pi's resolver for the same installed Blackhole config parser.
  const { createJiti } = await import(path.join(host, '../../jiti/lib/jiti.mjs'));
  const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': path.join(host, 'dist/index.js'), '@earendil-works/pi-ai': path.join(host, '../pi-ai/dist/index.js') } });
  const { loadUnifiedConfig } = await jiti.import(path.join(agentDir, 'npm/node_modules/pi-blackhole/src/core/unified-config.ts'));
  assert.equal(loadUnifiedConfig(central).memory, false, 'Blackhole memory still active in central intake');
  assert.equal(loadUnifiedConfig(childRepo).memory, true, 'Blackhole memory changed in implementation repo');
  assert.equal(loadUnifiedConfig(central).compaction, loadUnifiedConfig(childRepo).compaction, 'Blackhole compaction changed');
  console.log('PASS installed Blackhole parser: central memory off, child memory on, compaction unchanged');
  if (process.argv.includes('--live')) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(central, '.pi/settings.json'), 'utf8')), settings);
    await live(central, false, true);
    await live(childRepo, true, false);
  }
  assert.ok(pids.every(pid => !alive(pid) && !groupAlive(pid)));
  console.log('ALL PASS ticket creation configuration and discovery');
} finally {
  clearTimeout(bound);
  if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} }
  fs.rmSync(temp, { recursive: true, force: true });
}
