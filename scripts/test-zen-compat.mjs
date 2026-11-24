#!/usr/bin/env node
/** Pi 1.6 renderer contracts, without model calls or the shared dependency tree. */
import assert from 'node:assert/strict';
import { loadExtension, repo, base, tui, themeModule } from './fixtures/code-blocks-runtime.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
const zen = await loadExtension(process.env.ZEN_TEST_EXTENSION ?? join(repo, 'pi/.pi/agent/extensions/zen.ts'));
const { ToolExecutionComponent } = await import(pathToFileURL(join(base, 'modes/interactive/components/tool-execution.js')));
const { readRenderers } = await import(pathToFileURL(join(base, 'core/tools/renderers/read.js')));
const root = mkdtempSync('/tmp/zen-compat-');
zen.__setConfigPathForTest(join(root, 'zen.json'));
const events = {}, commands = {};
zen.default({ registerFlag() {}, registerShortcut() {}, registerToolRenderer() {},
  registerCommand(name, fn) { commands[name] = fn; }, on(name, fn) { events[name] = fn; }, getFlag(name) { return name === 'zen'; } });
const resolve = zen.makeResolver(() => true);
const result = { content: [{ type: 'text', text: 'original tool data' }], details: {}, isError: false, durationMs: 421 };
const ctx = { cwd: root, state: {}, isError: false, durationMs: 421, invalidate() {}, outputPad: 1 };
const plain = lines => lines.map(tui.stripTerminalSequences).join('\n');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
try {
  themeModule.initTheme('dark'); events.session_start({}, {});
  const renderer = resolve('read', () => readRenderers);
  const row = renderer.renderCall({ path: 'image.png' }, themeModule.theme, ctx);
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, ctx);
  const initial = row.render(80);
  result.details.imageUnsupportedByModel = 'unsafe\x1b]52;c;secret\x07';
  const saved = JSON.stringify(result);
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, ctx);
  check('same-content metadata update shows safe image warning', () => assert.match(plain(row.render(80)), /image not sent/));
  check('warning paints new readonly rows without mutating the previous paint or result', () => {
    assert.notEqual(row.render(80), initial); assert(!plain(initial).includes('image not sent')); assert.equal(JSON.stringify(result), saved);
  });
  result.details.truncation = { truncated: true };
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, ctx);
  check('image warning remains visible alongside truncation', () => assert.match(plain(row.render(80)), /image not sent.*truncated/));
  check('warning does not expose raw model metadata or terminal commands', () => assert(!row.render(80).join('').includes('unsafe')));
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, { ...ctx, isError: true });
  check('error rows retain image warning', () => assert.match(plain(row.render(36)), /image not sent/));
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, ctx);
  check('warning fits narrow rows', () => { for (const width of [1, 6, 12, 36, 60]) assert(row.render(width).every(line => tui.visibleWidth(line) <= width)); });
  delete result.details.imageUnsupportedByModel; delete result.details.truncation;
  renderer.renderResult(result, { expanded: false, isPartial: false }, themeModule.theme, ctx);
  check('same-content metadata removal clears warnings', () => assert(!plain(row.render(80)).includes('image not sent')));
  check('session_compact releases registered closures', () => {
    assert(zen.__registrySizeForTest() > 0); assert.equal(typeof events.session_compact, 'function'); events.session_compact(); assert.equal(zen.__registrySizeForTest(), 0);
  });
  check('shutdown releases registered closures', () => {
    renderer.renderCall({}, themeModule.theme, ctx); events.session_shutdown(); assert.equal(zen.__registrySizeForTest(), 0);
  });
  for (const name of ['dark', 'light', 'system']) {
    themeModule.setTheme(name); events.session_start({}, {});
    const compact = new ToolExecutionComponent('read', 'read', { path: 'fixture.txt' }, { showImages: false, outputPad: 1 }, resolve('read', () => readRenderers), { requestRender() {} }, root);
    const native = new ToolExecutionComponent('read', 'read', { path: 'fixture.txt' }, { showImages: false, outputPad: 1 }, readRenderers, { requestRender() {} }, root);
    compact.updateResult(result, false); native.updateResult(result, false);
    compact.setExpanded(true); native.setExpanded(true);
    check(name + ' expanded framing, width, padding and invalidate parity', () => {
      for (const width of [36, 80, 120]) { compact.invalidate(); native.invalidate(); assert.deepEqual(compact.render(width), native.render(width)); }
      compact.setOutputPad(2); native.setOutputPad(2); assert.deepEqual(compact.render(80), native.render(80));
    });
    await commands.zen.handler('off', { ui: { notify() {} } });
    compact.setExpanded(false); native.setExpanded(false);
    check(name + ' toggle-off native parity', () => assert.deepEqual(compact.render(80), native.render(80)));
    await commands.zen.handler('on', { ui: { notify() {} } });
    check(name + ' mouse expansion parity', () => {
      const mouse = { type: 'click', button: 'left', x: 2, y: 1, width: 80, height: 2 };
      assert(compact.handleMouse(mouse)?.handled); native.setExpanded(true); assert.deepEqual(compact.render(80), native.render(80));
    });
  }
  check('native Box observes child updates without outer invalidation', () => {
    events.session_start({}, {});
    const child = new tui.Text('old detail', 0, 0);
    const r = resolve('read', () => ({ renderCall() { return child; } }));
    const frame = r.renderCall({}, themeModule.theme, { ...ctx, state: {}, expanded: true });
    const old = frame.render(80);
    child.setText('new detail');
    assert.match(plain(frame.render(80)), /new detail/); assert.match(plain(old), /old detail/);
    assert.equal(frame.render(80), frame.render(80), 'Built-in Box cache must reuse readonly lines');
  });
  console.log(checks + ' compatibility checks passed');
} finally { events.session_shutdown?.(); themeModule.setTheme('dark'); rmSync(root, { recursive: true, force: true }); }
