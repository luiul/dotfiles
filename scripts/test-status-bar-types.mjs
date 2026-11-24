#!/usr/bin/env node
// Use installed Pi declarations explicitly. Do not repoint shared package links.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modules, runtimeModule, version } from './test-status-bar-runtime.mjs';

const require = createRequire(import.meta.url);
const compiler = process.env.SB_TYPESCRIPT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/typescript.js';
const ts = require(compiler);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repo, 'pi/.pi/agent/extensions/status-bar.ts');
const packages = ['pi-coding-agent', 'pi-tui', 'pi-agent-core', 'pi-ai'];
const options = {
  noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, types: ['node'], typeRoots: [join(modules, '@types')],
  paths: Object.fromEntries(packages.map(name => [`@earendil-works/${name}`, [runtimeModule(name, 'dist/index.d.ts')]])),
};
const program = ts.createProgram([source], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => repo, getCanonicalFileName: file => file, getNewLine: () => '\n',
}));
assert.equal(diagnostics.length, 0, 'Footer does not type-check against the installed Pi declarations');
console.log(`PASS status-bar strict types: Pi ${version}, TypeScript ${ts.version}, ${source}`);
