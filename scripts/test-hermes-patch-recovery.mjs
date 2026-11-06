#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, preparePatch, recoverPatch, supportedVersions } from './patch-hermes-memory.mjs';
const root=mkdtempSync(join(tmpdir(),'hermes-patch-recovery-'));
const source=join(homedir(),'.pi/agent/npm/node_modules/pi-hermes-memory');
try {
  const fixture=label=>{const p=join(root,label);cpSync(source,p,{recursive:true,filter:x=>!x.slice(source.length).includes('/node_modules')});return p;};
  const p=fixture('stage-failure'),original=readFileSync(join(p,'src/handlers/message-parts.ts'));
  const collision=join(p,'src/constants.ts.hardening-tmp');writeFileSync(collision,'other writer');
  assert.throws(()=>applyPatch(p,true),/EEXIST/);assert.deepEqual(readFileSync(join(p,'src/handlers/message-parts.ts')),original);
  assert.equal(readFileSync(collision,'utf8'),'other writer');rmSync(collision);assert.equal(applyPatch(p,true).applied,true);
  const markerCollision=fixture('marker-collision');const markerTmp=join(markerCollision,'.pi-memory-hardening.json.hardening-tmp');writeFileSync(markerTmp,'another writer');
  const before=readFileSync(join(markerCollision,'src/handlers/message-parts.ts'));
  assert.throws(()=>applyPatch(markerCollision,true),/EEXIST/);assert.equal(readFileSync(markerTmp,'utf8'),'another writer');assert.deepEqual(readFileSync(join(markerCollision,'src/handlers/message-parts.ts')),before);
  for (const version of supportedVersions) {
    const supported = fixture(`supported-${version}`);
    const metadata = JSON.parse(readFileSync(join(supported, 'package.json'), 'utf8'));
    writeFileSync(join(supported, 'package.json'), JSON.stringify({ ...metadata, version }));
    assert.equal(preparePatch(supported).version, version);
    assert.equal(applyPatch(supported, true).applied, true);
    assert.equal(JSON.parse(readFileSync(join(supported, '.pi-memory-hardening.json'), 'utf8')).version, version);
    assert.equal(applyPatch(supported, true).applied, false);
  }
  for (const version of ['0.9.12', '0.10.1', '0.11.0']) {
    const broken = fixture(`wrong-${version}`);
    writeFileSync(join(broken, 'package.json'), JSON.stringify({ version }));
    assert.throws(() => preparePatch(broken), /version/);
    assert.throws(() => applyPatch(broken, true), /version/);
    assert(!existsSync(join(broken, '.pi-memory-hardening.json')));
    assert(!existsSync(join(broken, '.pi-memory-hardening-lock')));
  }
  const backup=fixture('unsafe-backup');symlinkSync(root,join(backup,'.pi-memory-hardening-baseline'));assert.throws(()=>applyPatch(backup,true),/Unsafe/i);
  const nested=fixture('unsafe-parent');mkdirSync(join(nested,'.pi-memory-hardening-baseline'));symlinkSync(root,join(nested,'.pi-memory-hardening-baseline/src'));
  assert.throws(()=>applyPatch(nested,true),/symlink/);assert(!existsSync(join(root,'handlers')));
  const locked=fixture('locked');mkdirSync(join(locked,'.pi-memory-hardening-lock'));assert.throws(()=>applyPatch(locked,true),/EEXIST/);
  writeFileSync(join(locked,'.pi-memory-hardening-lock/owner.json'),JSON.stringify({pid:process.pid}));
  assert.throws(()=>recoverPatch(locked,true),/live or reused/);
  console.log('PASS exact supported versions, marker version, unknown releases reject, staged failures preserve sources and other writers, symlinks and locks reject');
}finally{rmSync(root,{recursive:true,force:true});assert(!existsSync(root));}
