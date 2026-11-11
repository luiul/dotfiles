/** Load the installed Pi runtime, sharing the host classes with the candidate. */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
export const modules = realpathSync(join(homedir(), '.pi/agent/install/releases', version, 'node_modules'));
export const base = join(modules, '@earendil-works/pi-coding-agent/dist');
export const cli = join(base, 'cli.js');
export const tui = await import(pathToFileURL(join(modules, '@earendil-works/pi-tui/dist/index.js')).href);
export const themeModule = await import(pathToFileURL(join(base, 'modes/interactive/theme/theme.js')).href);
export const { createMermaidMarkdownTransformer } = await import(pathToFileURL(join(base, 'modes/interactive/components/mermaid.js')).href);
const { createJiti } = await import(pathToFileURL(join(modules, 'jiti/lib/jiti.mjs')).href);
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-tui': join(modules, '@earendil-works/pi-tui/dist/index.js'),
  '@earendil-works/pi-coding-agent': join(base, 'index.js'),
} });
export const loadExtension = path => jiti.import(path);
export const candidate = await loadExtension(join(repo, 'pi/.pi/agent/extensions/code-blocks/index.ts'));
export const fence = (language, text) => '```' + language + '\n' + text + '\n```';
export const fixtures = {
  small: fence('typescript', 'const answer: number = 42;\n\nfunction greet(name: string): string {\n  return `Hello, ${name}`;\n}'),
  filename: fence('typescript example.ts', 'const answer: number = 42;'),
  unicode: fence('python', 'def greet():\n    return "日本語 café 👋"'),
  long: fence('bash', 'printf "%s\\n" "' + 'Long source line '.repeat(8).trim() + '"'),
  mermaid: fence('mermaid', 'flowchart TD\n A[Pi reply] --> B[Native renderer]\n B --> C[Terminal display]'),
  pie: fence('mermaid', 'pie title Work\n "Done" : 60\n "Pending" : 40'),
  invalidMermaid: fence('mermaid', 'flowchart TD\n A --> B\n NOT_MERMAID &%$'),
};
export function markdown(source, patch, { pad = 0, mermaid = false, surface = 'assistant', extension = candidate } = {}) {
  const nativeMermaid = createMermaidMarkdownTransformer({ getMode: () => 'streaming', theme: themeModule.theme });
  return new tui.Markdown(source, pad, 0, { ...themeModule.getMarkdownTheme(), codeBlockIndent: '' }, undefined, {
    transform(text, width) {
      if (mermaid) text = nativeMermaid(text, { messageType: surface, isStreaming: false, availableWidth: width });
      return patch && surface === 'assistant' ? extension.replyScope(patch, text) : text;
    },
  });
}
