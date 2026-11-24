#!/usr/bin/env node
/** Strict current-runtime types for the reviewed custom extensions. No shared links change. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modules, runtimeModule, version } from './test-status-bar-runtime.mjs';
const require = createRequire(import.meta.url);
const ts = require(process.env.SB_TYPESCRIPT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/typescript.js');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['resource-budget.ts', 'bedrock-openai-reasoning.ts', 'session-title.ts', 'status-bar.ts', 'zen.ts', 'code-blocks/index.ts'];
const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, resolveJsonModule: true, esModuleInterop: true, types: ['node'], typeRoots: [join(modules, '@types')], paths: Object.fromEntries(['pi-coding-agent', 'pi-tui', 'pi-agent-core', 'pi-ai'].map(name => [`@earendil-works/${name}`, [runtimeModule(name, 'dist/index.d.ts')]])) };
const program = ts.createProgram(files.map(file => join(repo, 'pi/.pi/agent/extensions', file)), options);
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => repo, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
assert.equal(diagnostics.length, 0, 'Reviewed extensions must type-check against the installed Pi declarations');
console.log(`PASS ${files.length} custom extensions, strict Pi ${version} types, TypeScript ${ts.version}`);
