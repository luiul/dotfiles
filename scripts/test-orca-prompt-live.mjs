#!/usr/bin/env node
/** Real Pi terminal discovery and expansion. No network calls or Orca workers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

assert(!process.versions.bun, 'Use Node for private Rex tests');
assert(process.argv.slice(2).every(arg => arg === '--live'), 'Only --live is supported');
const live = process.argv.includes('--live');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = join(homedir(), '.pi/agent/install');
const release = readFileSync(join(install, 'current-version'), 'utf8').trim();
const packageRoot = join(install, 'releases', release, 'node_modules/@earendil-works/pi-coding-agent');
const cli = join(packageRoot, 'dist/cli.js');
const candidate = join(repo, 'pi/.pi/agent/prompts/orca.md');
const promptPath = live ? join(homedir(), '.pi/agent/prompts/orca.md') : candidate;
const fixture = join(repo, 'scripts/fixtures/orca-prompt-live.ts');
assert(existsSync(promptPath), 'Prompt is not deployed: ' + promptPath);
assert.equal(readFileSync(promptPath, 'utf8'), readFileSync(candidate, 'utf8'), 'Live prompt differs from reviewed source');
const { loadPromptTemplates, expandPromptTemplate } = await import(pathToFileURL(join(packageRoot, 'dist/core/prompt-templates.js')));
const templates = loadPromptTemplates({ cwd: repo, agentDir: join(repo, 'pi/.pi/agent'), promptPaths: [candidate], includeDefaults: false });
assert.deepEqual(templates.diagnostics, []);
const root = mkdtempSync(join(tmpdir(), 'orca-prompt-'));
const config = join(root, 'home/.pi/agent');
mkdirSync(config, { recursive: true });
writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'orca-prompt-fixture', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }));
const eventPath = join(root, 'events.jsonl');
const deadline = Date.now() + 150000;
let driver;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const events = () => {
  if (!existsSync(eventPath)) return [];
  const text = readFileSync(eventPath, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
};
async function wait(host, predicate, label) {
  let screen = '';
  const until = Math.min(deadline, Date.now() + 30000);
  while (Date.now() < until) {
    screen = driver.capture(host);
    assert(!/Failed to load extension|Extension error|TypeError:|Unhandled/i.test(screen), screen);
    if (predicate(screen, events())) return screen;
    assert(!driver.process(host).last_exit, 'Pi exited: ' + screen);
    await sleep(120);
  }
  throw new Error('Timeout ' + label + '\n' + screen);
}
try {
  driver = await RexTestDriver.start({ deadlineMs: 150000 });
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '--thinking', 'off', '--provider', 'orca-prompt-fixture', '--model', 'fixture', '--models', 'orca-prompt-fixture/fixture', '--tui-mode', 'fullscreen', '--session-dir', join(root, 'sessions'), '-e', fixture];
  // Candidate mode previews one resource without modifying the live agent directory.
  if (!live) args.push('--no-prompt-templates', '--prompt-template', candidate);
  const host = driver.create({ name: `ag-orca-prompt-${process.pid}`, command: args, cwd: root,
    env: { HOME: join(root, 'home'), PATH: '/opt/homebrew/bin:/usr/bin:/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: live ? join(homedir(), '.pi/agent') : config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', ORCA_PROMPT_EVENTS: eventPath }, columns: 120, rows: 36 });
  await wait(host, (_screen, list) => list.some(e => e.type === 'ready'), 'startup');
  // Resource discovery finishes after session_start. Autocomplete proves the editor loaded it too.
  driver.text(host, '/orc');
  await wait(host, screen => screen.includes('Coordinate a task through Orca'), 'command completion');
  console.log(`PASS Pi ${release}: /orca autocomplete, ${live ? 'live auto-discovery' : 'candidate preview'}, private Rex 120x36`);
  const inputs = [
    '/orca Discover the owning repo; do not edit files',
    '/orca Plan only for https://hellofresh.atlassian.net/browse/GLOA-123',
    '/orca Implement approved scope; leave changes unstaged',
    '/orca "First alert\nUSER_ACCESS_DISABLED\nCluster: example"',
    '/orca',
  ];
  for (let i = 0; i < inputs.length; i++) {
    driver.key(host, 'ctrl+u');
    // Bracketed paste keeps embedded newlines in the editor until explicit submission.
    driver.text(host, '\x1b[200~' + inputs[i] + '\x1b[201~');
    driver.key(host, 'enter');
    await wait(host, (screen, list) => list.filter(e => e.type === 'settled').length === i + 1 && screen.includes(`ORCA_PROMPT_EXPANDED_${i + 1}`), 'expansion ' + i);
    const list = events();
    assert.equal(list.filter(e => e.type === 'input').at(-1).text, inputs[i]);
    const expected = expandPromptTemplate(inputs[i], templates.templates);
    assert.equal(list.filter(e => e.type === 'expanded').at(-1).prompt, expected);
    assert.equal(list.filter(e => e.type === 'model-call').at(-1).prompt, expected);
    assert.equal(list.filter(e => e.type === 'model-call').length, i + 1);
    console.log('PASS real TUI input, template expansion and provider delivery: ' + ['discovery', 'planning', 'implementation', 'multiline evidence', 'empty request'][i]);
  }
  driver.text(host, '/reload'); driver.key(host, 'enter');
  await wait(host, (_screen, list) => list.filter(e => e.type === 'ready').length === 2, 'reload');
  driver.text(host, '/orc');
  await wait(host, screen => screen.includes('Coordinate a task through Orca'), 'reload completion');
  assert.equal(events().filter(e => e.type === 'model-call').length, inputs.length);
  driver.key(host, 'ctrl+u');
  driver.key(host, 'ctrl+d');
  await wait(host, (_screen, list) => list.some(e => e.type === 'shutdown' && e.reason === 'quit'), 'graceful exit');
  console.log('PASS reload discovery and graceful shutdown without another model call');
} finally {
  await driver?.stop();
  rmSync(root, { recursive: true, force: true });
}
console.log('ALL PASS: private Rex cleanup verified; source SHA256 ' + createHash('sha256').update(readFileSync(candidate)).digest('hex'));
console.log('Scope: local fixture only. No LLM compliance, worker coordination, tracker writes or production behavior tested.');
