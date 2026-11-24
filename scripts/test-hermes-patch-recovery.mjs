#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, preparePatch, recoverPatch, supportedVersions } from './patch-hermes-memory.mjs';
const root=mkdtempSync(join(tmpdir(),'hermes-patch-recovery-'));
import { copyHermesBaseline } from './test-hermes-fixture.mjs';
try {
  const fixture=label=>copyHermesBaseline(join(root,label));
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
  const dead=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});await once(dead,'close');
  const recoverable=fixture('dead-owner'), lock=join(recoverable,'.pi-memory-hardening-lock');mkdirSync(lock);
  writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:dead.pid}));
  const plan=preparePatch(recoverable);writeFileSync(plan.updates[0].path+'.hardening-tmp',plan.updates[0].text);
  assert.equal(recoverPatch(recoverable,true).applied,true);assert(!existsSync(lock));assert(!existsSync(plan.updates[0].path+'.hardening-tmp'));
  const unknown=fixture('unknown-stage'), unknownLock=join(unknown,'.pi-memory-hardening-lock');mkdirSync(unknownLock);writeFileSync(join(unknownLock,'owner.json'),JSON.stringify({pid:dead.pid}));
  const unknownStage=preparePatch(unknown).updates[0].path+'.hardening-tmp';writeFileSync(unknownStage,'unknown bytes');
  assert.throws(()=>recoverPatch(unknown,true),/Unknown staging/);assert.equal(readFileSync(unknownStage,'utf8'),'unknown bytes');assert(existsSync(unknownLock));
  const markerRecovery=fixture('marker-recovery');applyPatch(markerRecovery,true);
  const marker=join(markerRecovery,'.pi-memory-hardening.json'), stagedMarker=marker+'.hardening-tmp';
  const expectedMarker=readFileSync(marker);writeFileSync(stagedMarker,expectedMarker);rmSync(marker);
  const markerLock=join(markerRecovery,'.pi-memory-hardening-lock');mkdirSync(markerLock);writeFileSync(join(markerLock,'owner.json'),JSON.stringify({pid:dead.pid}));
  assert.equal(recoverPatch(markerRecovery,true).applied,true);
  assert.deepEqual(readFileSync(marker),expectedMarker);assert(!existsSync(stagedMarker));assert(!existsSync(markerLock));
  for(const suffix of ['bytes','version','revision','files']) {
    const unknownMarker=fixture('unknown-marker-'+suffix), unknownPlan=preparePatch(unknownMarker);
    const knownSourceStage=unknownPlan.updates[0].path+'.hardening-tmp';writeFileSync(knownSourceStage,unknownPlan.updates[0].text);
    const unknownMarkerLock=join(unknownMarker,'.pi-memory-hardening-lock');mkdirSync(unknownMarkerLock);
    const ownerBytes=JSON.stringify({pid:dead.pid});writeFileSync(join(unknownMarkerLock,'owner.json'),ownerBytes);
    const wrong=JSON.parse(expectedMarker);
    if(suffix==='version')wrong.version='0.11.0';
    if(suffix==='revision')wrong.revision='unknown';
    if(suffix==='files')wrong.files[unknownPlan.updates[0].file]='0'.repeat(64);
    const wrongBytes=suffix==='bytes'?'unknown bytes':JSON.stringify(wrong,null,2)+'\n';
    const unknownMarkerStage=join(unknownMarker,'.pi-memory-hardening.json.hardening-tmp');writeFileSync(unknownMarkerStage,wrongBytes);
    assert.throws(()=>recoverPatch(unknownMarker,true),/Unknown staging/);
    assert.equal(readFileSync(unknownMarkerStage,'utf8'),wrongBytes);
    assert.equal(readFileSync(knownSourceStage,'utf8'),unknownPlan.updates[0].text);
    assert.equal(readFileSync(join(unknownMarkerLock,'owner.json'),'utf8'),ownerBytes);
    assert(!existsSync(join(unknownMarker,'.pi-memory-hardening.json')));
  }
  console.log('PASS exact marker staging recovery; unknown bytes/version/revision/files preserve marker, source staging and owner lock');
  console.log('PASS dead-owner recovery retains reviewed baseline, known staging retry succeeds; unknown staging preserves lock and bytes');
  console.log('PASS exact supported versions, marker version, unknown releases reject, staged failures preserve sources and other writers, symlinks and locks reject');
}finally{rmSync(root,{recursive:true,force:true});assert(!existsSync(root));}
