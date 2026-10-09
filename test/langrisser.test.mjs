import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { matches, targetPoint, classify } from '../lib/langrisser/recognition.mjs';
import { runRecipe, RunStore } from '../lib/langrisser/runner.mjs';

const frame = word => ({frontmost:true,generation:1,text:[{text:word,confidence:1,box:{x:.4,y:.4,width:.2,height:.1}}]});
const recipe = {version:1,id:'unit',stageId:'main-1-4',executionScope:'menu',sourceUrl:'https://example.org',steps:[
  {id:'first',before:{all:['ready']},after:{all:['done']},action:{type:'click',text:'ready'},timeoutMs:100}
]};
function mock(frames) {
  const calls = []; let i=0;
  return {calls,request:async (command) => {
    calls.push(command);
    if (command==='doctor') return {screenRecording:true,accessibility:true,gameRunning:true};
    if (command==='capture') return frames[Math.min(i++,frames.length-1)];
    return {sent:true};
  }};
}
async function temporary(t) {
  const path = await mkdtemp(resolve(tmpdir(),'langrisser-test-'));
  t.after(()=>rm(path,{recursive:true,force:true})); return new RunStore(path);
}
test('real Korean screenshot is recognized and OCR button ambiguity is rejected',async()=>{
  const fixture = JSON.parse(await readFile(new URL('./fixtures/langrisser/stage-details.json',import.meta.url)));
  assert.equal(classify(fixture),'stage-details');
  assert(matches(fixture,{all:['섬의 손님','승리조건'],none:['전투 승리']}));
  assert.equal(matches(fixture,{none:['전투 승리']}),false);
  const duplicate = frame('ready'); duplicate.text.push({...duplicate.text[0]});
  assert.throws(()=>targetPoint(duplicate,{text:'ready'}),/AMBIGUOUS_TARGET/);
});
test('validation does not send any input or pretend a clear',async()=>{
  const bridge=mock([]);
  const result=await runRecipe(recipe,{bridge});
  assert.equal(result.status,'validated-only'); assert.equal(bridge.calls.length,0);
});
test('battle entry recognizes observed decorated SKIP and preparation text',async()=>{
  const entry=JSON.parse(await readFile(new URL('../profiles/langrisser/main-1-4-enter-battle.json',import.meta.url)));
  const intro=JSON.parse(await readFile(new URL('./fixtures/langrisser/intro-after-deploy.json',import.meta.url)));
  const preparation=JSON.parse(await readFile(new URL('./fixtures/langrisser/battle-preparation.json',import.meta.url)));
  assert(matches(intro,entry.steps[0].after));
  assert(matches(intro,entry.steps[1].before));
  assert.equal(targetPoint(intro,entry.steps[1].action).length,2);
  assert(matches(preparation,entry.steps[3].after));
  assert(matches(preparation,entry.steps[4].before));
  assert.equal(matches(intro,entry.steps[4].before),false);
});
test('mismatched screen stops before input',async t=>{
  const store=await temporary(t),bridge=mock([frame('wrong')]);
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true}),/SCREEN_MISMATCH/);
  assert(!bridge.calls.includes('click'));
});
test('successful transition advances exactly once; resume does not replay',async t=>{
  const store=await temporary(t),bridge=mock([frame('ready'),frame('done')]);
  const result=await runRecipe(recipe,{bridge,store,live:true,pollMs:1,log:()=>{}});
  assert.equal(result.phase,'finished'); assert.equal(result.outcome,'recipe-only');
  await runRecipe(recipe,{bridge,store,live:true});
  assert.equal(bridge.calls.filter(x=>x==='click').length,1);
});
test('unconfirmed click is not retried and cannot resume automatically',async t=>{
  const store=await temporary(t),bridge=mock([frame('ready')]);
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true,pollMs:1}),/POSTCONDITION_TIMEOUT/);
  assert.equal((await store.load()).phase,'ambiguous');
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true}),/AMBIGUOUS_CHECKPOINT/);
  assert.equal(bridge.calls.filter(x=>x==='click').length,1);
});
test('stop and foreground checks prevent dispatch',async t=>{
  const store=await temporary(t),bridge=mock([{...frame('ready'),frontmost:false}]);
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true}),/GAME_NOT_FRONTMOST/);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true,signal:controller.signal}),/STOPPED/);
  assert(!bridge.calls.includes('click'));
});
test('slow OCR startup is discarded before choosing a target',async t=>{
  const store=await temporary(t),bridge=mock([{...frame('ready'),elapsedMs:18000},frame('wrong')]);
  await assert.rejects(runRecipe(recipe,{bridge,store,live:true,pollMs:1}),/SCREEN_MISMATCH/);
  assert.equal(bridge.calls.filter(x=>x==='capture').length,2);
  assert(!bridge.calls.includes('click'));
});
test('all guide index entries have a source, Korean note and truthful unverified status',async()=>{
  const data=JSON.parse(await readFile(new URL('../data/langrisser/guides.json',import.meta.url)));
  assert.equal(data.stages.length,118); assert.equal(new Set(data.stages.map(s=>s.id)).size,118);
  assert.equal(data.coverage.verifiedAutomaticClears,data.stages.filter(s=>s.verifiedClear).length);
  for(const stage of data.stages) { assert(stage.sourceUrl.startsWith('https://langrisser.wikiru.jp/')); assert(stage.summaryKo); assert(stage.sourceSha256); }
  const profile=JSON.parse(await readFile(new URL('../profiles/langrisser/verify-stage-details.json',import.meta.url)));
  assert(data.stages.some(s=>s.id===profile.stageId), '실행 계획과 공략의 스테이지 ID가 일치해야 함');
});
