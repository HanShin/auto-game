import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertGuideExecution, recipeDigest } from '../lib/langrisser/guide-policy.mjs';
import { runRecipe } from '../lib/langrisser/runner.mjs';

const recipe = {version:1,id:'combat-fixture',stageId:'main-1-4',sourceUrl:'https://example.org/guide',
  guideRouteId:'reviewed',steps:[{id:'move',sourceActionId:'source-move',action:{type:'click',point:[.3,.4]},before:{all:['ready']},after:{all:['moved']}}]};
const reviewed = () => ({id:'reviewed',stageId:'main-1-4',status:'ready',sequenceReviewed:true,
  screenMappingVerified:true,recipeSha256:recipeDigest(recipe),unresolved:[],
  sources:[{id:'video',url:'https://example.org/guide'}],
  actions:[{id:'source-move',sourceId:'video',atSeconds:18.4,verified:true}]});

test('source URL alone never permits live combat or bridge access',async()=>{
  const calls=[];
  await assert.rejects(runRecipe(recipe,{live:true,bridge:{request:async command=>calls.push(command)}}),/GUIDE_NOT_READY/);
  assert.deepEqual(calls,[]);
});
test('paused source review blocks entry and menus, but permits read-only observation',()=>{
  const policy={inputHold:{active:true,reason:'source review'}};
  assert.throws(()=>assertGuideExecution({...recipe,executionScope:'battle-entry'},{policy}),/GUIDE_INPUT_HELD/);
  assert.throws(()=>assertGuideExecution({...recipe,executionScope:'menu'},{policy}),/GUIDE_INPUT_HELD/);
  assert.doesNotThrow(()=>assertGuideExecution({...recipe,steps:[{action:{type:'observe'}}]},{policy}));
});
test('single-stage calibration cannot send inputs to another stage, even through entry plans',async()=>{
  const policy={allowedStageIds:['main-1-4']};
  assert.doesNotThrow(()=>assertGuideExecution({...recipe,executionScope:'battle-entry'},{policy}));
  const calls=[];
  await assert.rejects(runRecipe({...recipe,stageId:'main-1-5',executionScope:'battle-entry'},
    {live:true,guidePolicy:policy,bridge:{request:async command=>calls.push(command)}}),/GUIDE_STAGE_NOT_AUTHORIZED/);
  assert.deepEqual(calls,[]);
  assert.doesNotThrow(()=>assertGuideExecution({...recipe,stageId:'main-1-5',steps:[{action:{type:'observe'}}]},{policy}));
});
test('old unrecorded plans cannot resume camera or battle inputs before bridge access',async()=>{
  const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url)));
  const policy=await read('../data/langrisser/execution-policy.json');
  const routes=(await read('../data/langrisser/video-routes.json')).routes;
  const camera=await read('../profiles/langrisser/main-1-4-camera-t6.json');
  const calls=[];
  await assert.rejects(runRecipe(camera,{live:true,guidePolicy:policy,guideRoutes:routes,
    bridge:{request:async command=>calls.push(command)}}),/RECORDED_PLAN_REQUIRED/);
  assert.deepEqual(calls,[]);
  // Removing the global hold must not accidentally promote this untested drag.
  assert.throws(()=>assertGuideExecution(camera,{routes}),/GUIDE_NOT_READY/);
});
test('combat review must match the exact stage and unchanged plan',()=>{
  assert.doesNotThrow(()=>assertGuideExecution(recipe,{routes:[reviewed()]}));
  for (const change of [{stageId:'main-1-5'},{status:'partial-source-review'},
    {sequenceReviewed:false},{screenMappingVerified:false},{unresolved:['unknown target']}]) {
    assert.throws(()=>assertGuideExecution(recipe,{routes:[{...reviewed(),...change}]}),/GUIDE_NOT_READY/);
  }
  const changed=structuredClone(recipe);changed.steps[0].action.point=[.5,.5];
  assert.throws(()=>assertGuideExecution(changed,{routes:[reviewed()]}),/GUIDE_NOT_READY/);
});
test('every combat input needs reviewed evidence at a source timestamp or section',()=>{
  for (const change of [{verified:false},{atSeconds:null},{atSeconds:-1},{sourceId:'missing'},{id:'different'}]) {
    const route=reviewed();Object.assign(route.actions[0],change);
    assert.throws(()=>assertGuideExecution(recipe,{routes:[route]}),/GUIDE_STEP_UNVERIFIED/);
  }
  const written=reviewed();delete written.actions[0].atSeconds;written.actions[0].section='Turn 1, step 2';
  assert.doesNotThrow(()=>assertGuideExecution(recipe,{routes:[written]}));
});
test('saved partial review and indexed videos do not imply runnable routes or game clears',async()=>{
  const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url)));
  const routes=(await read('../data/langrisser/video-routes.json')).routes;
  const sources=await read('../data/langrisser/video-sources.json');
  assert.equal(sources.videos.length,155);
  assert.equal(new Set(sources.videos.map(v=>v.videoId)).size,155);
  assert.equal(sources.catalogVerifiedAgainstKoreanGame,false);
  assert.equal(routes[0].objectiveEvidence.localGameAllObjectivesClear,false);
  assert.throws(()=>assertGuideExecution({...recipe,guideRouteId:routes[0].id},{routes}),/GUIDE_NOT_READY/);
});
