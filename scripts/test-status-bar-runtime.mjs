// Footer tests resolve the managed release, never the worktree's shared node_modules.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const install = join(homedir(), '.pi/agent/install');
export const modules = process.env.SB_PI_MODULES ?? join(install, 'releases', readFileSync(join(install, 'current-version'), 'utf8').trim(), 'node_modules');
export const cli = process.env.SB_LIVE_PI_CLI ?? join(modules, '@earendil-works/pi-coding-agent/dist/cli.js');
export const version = JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf8')).version;
export const runtimeModule = (packageName, file = 'dist/index.js') => resolve(modules, '@earendil-works', packageName, file);
export const { SettingsManager } = await import(pathToFileURL(runtimeModule('pi-coding-agent', 'dist/core/settings-manager.js')).href);
export const tui = await import(pathToFileURL(runtimeModule('pi-tui')).href);
