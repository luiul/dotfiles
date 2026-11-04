#!/usr/bin/env node
// Config checks only. No network, model calls, or live file writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=path.join(repo,'pi/.pi/agent');
const json=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const settings=json('settings.json');
const models=json('models.json');
const router=models.providers['ai-model-router'];
const roles={
 Daily:['GPT-6.1 Terra','high','Coding and admin'],
 Think:['GPT-6.1 Sol','medium','Hard problems and advice'],
 Budget:['GLM 5.3','high','Lower-cost coding'],
 Quick:['GPT-6 Luna','low','Lookups and simple tasks'],
 Helper:['GLM 5.3 Flash','off','Summaries and memory checks'],
};
const scope=[
 'ai-model-router/GPT-6.1 Terra',
 'ai-model-router/GPT-6.1 Sol',
 'ai-model-router/GLM 5.3',
 'ai-model-router/GPT-6 Luna',
 'google-vertex/gemini-4-argon',
 'ai-model-router/GLM 5.3 Flash',
];
assert.equal(settings.defaultProvider,'ai-model-router');
assert.equal(settings.defaultModel,'GPT-6.1 Terra');
assert.equal(settings.defaultThinkingLevel,'high');
assert.deepEqual(settings.enabledModels,scope);
assert.equal(new Set(router.models.map(m=>m.id)).size,router.models.length);
for(const [role,[id,thinking,description]] of Object.entries(roles)){
 const model=router.models.find(m=>m.id===id);
 assert(model,`Missing ${id}`);
 assert.equal(model.name,role+' | '+description);
 assert.equal(router.models.filter(m=>m.name?.startsWith(role+' | ')).length,1,`Ambiguous ${role}`);
 assert.equal(settings.modelThinkingLevels['ai-model-router/'+id],thinking);
}
assert.equal(models.providers['google-vertex'].modelOverrides['gemini-4-argon'].name,'Vision | Images, scans and floorplans');
assert.equal(settings.modelThinkingLevels['google-vertex/gemini-4-argon'],'high');
assert(router.models.some(m=>m.id==='Kimi K3'),'All-model catalog must preserve Kimi');
assert(router.models.some(m=>m.id==='DeepSeek V4 Flash'),'Worker catalog must preserve DeepSeek outside picker scope');
// The installed resolver proves scope patterns select the same six canonical IDs.
const runtimeDir=path.join(homedir(),'.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
const {resolveModelScopeFromModels}=await import(path.join(runtimeDir,'dist/core/model-resolver.js'));
const available=[
 ...router.models.map(model=>({...model,provider:'ai-model-router'})),
 {provider:'google-vertex',id:'gemini-4-argon',name:models.providers['google-vertex'].modelOverrides['gemini-4-argon'].name},
];
const resolved=resolveModelScopeFromModels(settings.enabledModels,available);
assert.deepEqual(resolved.diagnostics,[]);
assert.deepEqual(resolved.scopedModels.map(({model})=>model.provider+'/'+model.id),scope);
assert(!resolved.scopedModels.some(({model})=>model.id==='DeepSeek V4 Flash'));
// Optional real merged settings check, including the specialist project default.
if(process.argv[2]){
 const project=JSON.parse(fs.readFileSync(path.join(process.argv[2],'.pi/settings.json'),'utf8'));
 assert.equal(project.defaultProvider,'google-vertex');
 assert.equal(project.defaultModel,'gemini-4-argon');
 assert.equal(project.defaultThinkingLevel,'high');
 assert(!Object.hasOwn(project,'enabledModels'),'Project must inherit compact scope');
 const {SettingsManager}=await import(path.join(runtimeDir,'dist/core/settings-manager.js'));
 const merged=SettingsManager.create(process.argv[2],dir);
 assert.deepEqual(merged.getEnabledModels(),scope);
 assert.equal(merged.getDefaultProvider(),'google-vertex');
 assert.equal(merged.getDefaultModel(),'gemini-4-argon');
 for(const [role,[id,thinking]]of Object.entries(roles))assert.equal(merged.getModelThinkingLevel('ai-model-router',id),thinking,role);
}

const hermes=json('hermes-memory-config.json');
assert.equal(hermes.reviewTransport,'direct');
assert.equal(hermes.llmModelOverride,'ai-model-router/GLM 5.3 Flash');
assert.deepEqual(hermes.llmFallbackModels,['ai-model-router/GPT-6 Luna']);
assert.equal(hermes.llmThinkingOverride,'off');
const web=json('web-search.json');
assert.equal(web.workflow,'none');
assert.equal(web.summaryModel,'ai-model-router/GLM 5.3 Flash:off');
assert.equal(web.queryRewriteModel,'ai-model-router/GPT-6 Luna:low');
assert(!Object.keys(web).some(k=>/key|token|secret/i.test(k)));
const explore=fs.readFileSync(path.join(dir,'agents/Explore.md'),'utf8');
assert(explore.includes('model: ai-model-router/GPT-6 Luna'));
assert(explore.includes('thinking: low'));
const blackhole=json('pi-blackhole/pi-blackhole-config.json');
assert.equal(blackhole.sessionFallback,false);
for(const role of ['observer','reflector','dropper']){
 assert.equal(blackhole[role+'Model'].id,'DeepSeek V4 Flash');
 assert.equal(blackhole[role+'FallbackModels'][0].id,'GLM 5.3 Flash');
}
console.log('PASS six-model scope, Terra default, short roles, effort levels, helper availability and unchanged Blackhole routing');
