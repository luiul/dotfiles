#!/usr/bin/env node
/** Native Markdown regression tests. Run: node scripts/test-code-blocks.mjs */
import assert from 'node:assert/strict';
import { candidate, fixtures, fence, markdown, tui, themeModule } from './fixtures/code-blocks-runtime.mjs';
const { stripTerminalSequences: strip, visibleWidth } = tui;
themeModule.initTheme('dark');
let checks = 0;
const pass = text => { checks++; console.log('PASS ' + text); };
const plain = lines => lines.map(strip).map(line => line.trimEnd()).join('\n');
const before = tui.Markdown.prototype.render;
assert(candidate.installCodeFrames('future').reason);
assert.equal(tui.Markdown.prototype.render, before);
pass('Unsupported Pi versions leave native Markdown untouched');
const installed = candidate.installCodeFrames();
assert(installed.patch);
installed.patch.theme = themeModule.theme;
try {
  for (const width of [1, 2, 4, 5, 6, 12, 36, 60, 96, 160]) {
    for (const [name, source] of Object.entries(fixtures)) {
      for (const pad of [0, 1]) {
        if (width < pad * 2 + 2) continue; // Native margins cannot fit below this width.
        const component = markdown(source, installed.patch, { pad, mermaid: true });
        const rows = component.render(width);
        assert(rows.every(line => visibleWidth(line) <= width), name + ' exceeds width ' + width);
        assert.deepEqual(component.render(width), rows, 'Cached repaint changed output');
      }
    }
  }
  pass('Every fixture fits available widths up to 160 columns, with padding and cached repaints');
  const component = markdown(fixtures.small, installed.patch);
  const shown = plain(component.render(96));
  assert(shown.includes('╭─ typescript'));
  assert(shown.includes('  return `Hello, ${name}`;'));
  assert(!shown.includes('```'));
  assert(shown.includes('╰'));
  pass('Reply frames hide fences and preserve code and indentation');
  for (const surface of ['user', 'assistant-thinking', 'custom', 'summary', 'changelog']) {
    const rows = plain(markdown(fixtures.small, installed.patch, { surface }).render(96));
    assert(rows.includes('```typescript'), surface);
    assert(!rows.includes('╭─ typescript'), surface);
  }
  pass('User, thinking, custom, summary, and changelog code keep native rendering');
  const prose = '## Heading\n\nA **bold** paragraph with `inline code`.\n\n| Left | Right |\n| --- | --- |\n| A | B |\n\n- List item\n\n> Quote';
  assert.deepEqual(markdown(prose, installed.patch).render(60), markdown(prose).render(60));
  for (const source of ['> ' + fixtures.small.split('\n').join('\n> '), '- Item\n\n' + fixtures.small.split('\n').map(line => '  ' + line).join('\n')]) {
    for (const width of [7, 12, 36, 60]) {
      const rows = markdown(source, installed.patch).render(width);
      assert(rows.every(line => visibleWidth(line) <= width));
      assert(!plain(rows).split('\n').some(line => /^\s*[>│]*\s*╮$/.test(line)), 'Broken header');
    }
  }
  pass('Prose, lists, quotes, tables, and inline code retain native behavior');
  let calls = 0;
  const nativeTheme = themeModule.getMarkdownTheme();
  const cached = new tui.Markdown(fixtures.small, 0, 0, { ...nativeTheme, highlightCode(code, lang) {
    calls++; return nativeTheme.highlightCode(code, lang);
  } }, undefined, { transform: text => candidate.replyScope(installed.patch, text) });
  cached.render(96); cached.render(60); cached.render(36);
  assert.equal(calls, 1, 'Resize repeated highlighting');
  cached.setText(fixtures.small + '\n\nNew paragraph'); cached.render(60);
  assert.equal(calls, 1, 'Streaming prose repeated unchanged code highlighting');
  cached.invalidate(); cached.render(60); assert.equal(calls, 2);
  pass('Native block cache reuses highlighting across resize and streaming prose');
  const normal = markdown(fixtures.small, installed.patch).render(96);
  const filename = markdown(fixtures.filename, installed.patch).render(96);
  const styles = row => new Set(row.match(/\x1b\[[\d;]*m/g) ?? []).size;
  assert.equal(styles(normal[1]), styles(filename[1]));
  pass('Filename metadata no longer disables syntax highlighting');
  for (const name of ['mermaid', 'pie']) {
    const rows = plain(markdown(fixtures[name], installed.patch, { mermaid: true }).render(96));
    assert(!rows.includes('```mermaid'));
    assert(!rows.includes('╭─ mermaid'));
  }
  const invalid = plain(markdown(fixtures.invalidMermaid, installed.patch, { mermaid: true }).render(96));
  assert(invalid.includes('NOT_MERMAID'));
  assert(invalid.includes('not rendered:'));
  pass('Native diagrams stay native; invalid diagrams retain source and warning');
  const blocks = candidate.extractCodeBlocks(fixtures.long + '\n\n' + fixtures.unicode);
  assert.equal(blocks[0].content, 'printf "%s\\n" "' + 'Long source line '.repeat(8).trim() + '"');
  assert.equal(blocks[0].content.split('\n').length, 1);
  assert(blocks[1].content.includes('    return'));
  assert.equal(candidate.extractCodeBlocks('    indented source').length, 0);
  pass('On-demand copying preserves original logical lines and indentation');
  const snapshot = component.render(96);
  themeModule.setTheme('light'); component.invalidate();
  const light = component.render(96);
  assert.notDeepEqual(light, snapshot);
  assert.equal(plain(light), plain(snapshot));
  pass('Theme changes update styles without changing text');
  const narrow = plain(markdown(fixtures.small, installed.patch).render(5));
  assert(narrow.includes('```'));
  assert(!narrow.includes('╭'));
  const mixed = '    echo FIRST\n\n' + fence('bash', 'echo SECOND');
  const mixedRows = plain(markdown(mixed, installed.patch).render(60));
  assert.equal((mixedRows.match(/╭─/g) ?? []).length, 1);
  assert.equal(candidate.extractCodeBlocks(mixed)[0].content, 'echo SECOND');
  pass('Narrow and indented blocks stay native; copy numbering matches framed fences');
  const control = '\x1b]52;c;VEVTVA==\x07';
  const hostile = fence('typescript' + control, 'const answer = 42;' + control + '\x1b[2J\x07\x9b');
  const hostileRows = markdown(hostile, installed.patch).render(96);
  assert(!hostileRows.join('').includes(']52;'));
  assert(!hostileRows.join('').includes('\x1b[2J'));
  assert(!hostileRows.join('').includes('\x07'));
  assert(!hostileRows.join('').includes('\x9b'));
  assert(candidate.extractCodeBlocks(hostile)[0].content.includes(control));
  pass('Code and labels cannot emit terminal commands; explicit copy retains source');
  const streamed = markdown('', installed.patch);
  for (let i = 0; i <= fixtures.small.length; i++) {
    streamed.setText(fixtures.small.slice(0, i));
    assert(streamed.render(36).every(line => visibleWidth(line) <= 36));
  }
  pass('Every partial streaming prefix renders within width');
  assert(candidate.installCodeFrames().reason);
  pass('Duplicate installations do not stack prototype wrappers');
} finally { installed.dispose(); }
assert.equal(tui.Markdown.prototype.render, before);
assert(plain(markdown(fixtures.small).render(96)).includes('```typescript'));
pass('Shutdown restores native Markdown');
console.log(checks + ' checks passed');
