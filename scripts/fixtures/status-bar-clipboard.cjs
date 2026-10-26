/** Process-local native clipboard replacement. Never loads a system clipboard writer. */
'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');

assert(process.env.SB_LIVE_EVENTS, 'SB_LIVE_EVENTS is needed for the clipboard safety preload');
const note = (type, data = {}) => fs.appendFileSync(process.env.SB_LIVE_EVENTS,
  JSON.stringify({ type, at: Date.now(), pid: process.pid, ...data }) + '\n');
const clipboard = Object.freeze({
  __sbLiveClipboard: true,
  getText: async () => null,
  getImage: async () => null,
  getFilePaths: async () => [],
  setText: async (text) => note('clipboard', { text }),
});
const load = Module._load;
Module._load = function (request, parent, isMain) {
  // This matches all native clipboard candidates, before dlopen can touch the pasteboard.
  if (/(?:darwin|win32|linux)-platform(?:-x11)?\.node$/.test(String(request))) {
    note('clipboard-backend', { request });
    return clipboard;
  }
  return load.call(this, request, parent, isMain);
};
// Refuse platform fallbacks rather than pretending they are safe. Sync the ESM bindings
// so the public helper's imports also see the guard.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[name];
  const guard = (file) => {
    if (/(?:^|[\s/\\])(pbcopy|pbpaste|clip(?:\.exe)?|wl-copy|wl-paste|xclip|xsel|powershell(?:\.exe)?|termux-clipboard-(?:get|set))(?:$|[\s'";])/i.test(String(file))) {
      note('clipboard-blocked', { route: name, file: String(file) });
      throw new Error('System clipboard fallback blocked by SB live fixture');
    }
  };
  cp[name] = function (file, ...args) {
    guard(file);
    return original.call(this, file, ...args);
  };
  // execFile's custom promisifier resolves { stdout, stderr }, not a bare string.
  // Keep that public behavior or production Git lookups would fail inside the fixture.
  if (original[promisify.custom]) cp[name][promisify.custom] = function (file, ...args) {
    guard(file);
    return original[promisify.custom].call(this, file, ...args);
  };
}
syncBuiltinESMExports();
const write = process.stdout.write;
let tail = '';
process.stdout.write = function (chunk, ...args) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const combined = tail + text;
  if (/\x1b\]52;/.test(combined)) {
    note('clipboard-blocked', { route: 'OSC52' });
    throw new Error('Terminal clipboard write blocked by SB live fixture');
  }
  tail = combined.slice(-5);
  return write.call(this, chunk, ...args);
};
note('clipboard-preload');
