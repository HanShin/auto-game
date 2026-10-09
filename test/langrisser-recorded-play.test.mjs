import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { RunStore,runRecipe,validateRecipe } from '../lib/langrisser/runner.mjs';
import { compilePlaybook,inspectPlaybook,recordDigest,prepareExecutionInput } from '../lib/langrisser/playbook.mjs';
import { recipeDigest } from '../lib/langrisser/guide-policy.mjs';
import { answerHelpRequest,loadResumeRequest } from '../lib/langrisser/help-request.mjs';

const frame=text=>({frontmost:true,text:[{text,confidence:1,box:{x:.2,y:.2,width:.2,height:.1}}]});
const step=(id,before,after)=>({id,sourceActionId:id,before:{all:[before]},after:{all:[after]},
  action:{type:'click',point:[.3,.3]},beforeTimeoutMs:100,timeoutMs:100});
const plan=()=>({version:2,id:'recorded',stageId:'main-1-4',sourceUrl:'https://example.org/guide',
  guideRouteId:'recorded-source',steps:[step('attack','ready','defeated')]});
const recordFor=recipe=>({format:'langrisser-playbook',version:1,id:'local-record',stageId:recipe.stageId,title:'검증용',
  sources:[{id:'guide',url:recipe.sourceUrl}],instructions:recipe.steps.map(s=>({id:s.sourceActionId,sourceId:'guide',section:s.id,actionKo:s.id,verified:true})),
  review:{sequenceReviewed:true,screenMappingVerified:true,recipeSha256:recipeDigest(recipe)},execution:{recipe}});
function mock(words,{sameFrame=false}={}) {
  let n=0;const calls=[];
  return {calls,request:async(command,args)=>{
    calls.push({command,args});
    if(command==='doctor') return {screenRecording:true,accessibility:true,gameRunning:true};
    if(command==='capture') {
      const content=words[Math.min(n++,words.length-1)];
      return {...(typeof content==='string'?frame(content):content),generation:sameFrame?1:n,
        path:sameFrame?'/tmp/reused-frame.png':args.path};
    }
    return {sent:true};
  }};
}
async function setup(t,recipe=plan()) {
  const dir=await mkdtemp(resolve(tmpdir(),'recorded-play-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const record=recordFor(recipe);
  const compiled=compilePlaybook(record);
  const opened=[];
  return {record,recipe:compiled.recipe,store:new RunStore(dir),
    opened,options:{live:true,guideRoutes:[compiled.route],originalPlan:record,pollMs:1,log:()=>{},openGuide:async url=>opened.push(url)}};
}
const run=(s,bridge)=>runRecipe(s.recipe,{...s.options,store:s.store,bridge});
const clicks=bridge=>bridge.calls.filter(c=>c.command==='click').length;
const readRequest=s=>readFile(resolve(s.store.directory,'help-request.json'),'utf8').then(JSON.parse);

test('local record compiles, freezes its source, and rejects changed records or unmapped plans',()=>{
  const record=recordFor(plan());const compiled=compilePlaybook(record);
  assert.equal(compiled.recipe.executionRecord.sha256,recordDigest(record));
  const frozen={format:'langrisser-recorded-plan',version:1,recordSha256:recordDigest(record),record};
  assert.deepEqual(prepareExecutionInput(frozen),compiled);
  frozen.record.instructions[0].actionKo='different';
  assert.throws(()=>prepareExecutionInput(frozen),/PLAYBOOK_CHANGED/);
  const changed=recordFor(plan());changed.execution.recipe.steps[0].action.point=[.5,.5];
  assert.throws(()=>compilePlaybook(changed),/PLAYBOOK_NOT_READY/);
  assert.equal(inspectPlaybook({...record,execution:{recipe:null}}).ready,false);
});
test('temporary OCR gaps recover locally and a recorded branch runs without a question',async t=>{
  const p=plan();p.steps[0].branches=[{id:'survived',description:'기록된 마무리 공격',when:{all:['wounded']},next:'finish'}];
  p.steps[0].next='$finish';p.steps.push(step('finish','wounded','defeated'));
  const s=await setup(t,p);
  const b=mock(['loading','ready','noise','ready','ready','animation','wounded','wounded','wounded','wounded','defeated','defeated']);
  const result=await run(s,b);
  assert.equal(result.phase,'finished');assert.equal(result.stageComplete,false);assert.equal(clicks(b),2);
  assert.deepEqual(s.opened,[]);
  await assert.rejects(readRequest(s),{code:'ENOENT'});
  const snapshot=JSON.parse(await readFile(resolve(s.store.directory,'recipe-snapshot.json'),'utf8'));
  assert.deepEqual(snapshot,s.recipe);
  const events=await readFile(resolve(s.store.directory,'events.jsonl'),'utf8');
  assert.match(events,/"branch":"survived"/);
});
test('persistent ambiguity asks once; answering reobserve verifies the result without repeating input',async t=>{
  const s=await setup(t);const b=mock(['ready','ready','unknown']);
  const first=await run(s,b);const request=await readRequest(s);
  assert.equal(first.phase,'needs-user');assert.equal(request.resumePhase,'verify');assert.equal(clicks(b),1);
  assert(request.lastScreenshot);assert(request.expected.normal);
  assert.deepEqual(s.opened,['https://example.org/guide']);
  assert.equal(request.guideOpen.status,'open-requested');
  const idle=mock([]);await run(s,idle);
  assert.equal(idle.calls.length,0);assert.equal((await readRequest(s)).id,request.id);
  assert.equal(s.opened.length,1);
  await answerHelpRequest(s.store,'reobserve');
  const after=mock(['defeated','defeated']);const result=await run(s,after);
  assert.equal(result.phase,'finished');assert.equal(result.status,'recipe-finished');assert.equal(clicks(after),0);
  assert.equal(s.opened.length,1);
});
test('browser launch failure preserves the question and paused game instead of resuming',async t=>{
  const s=await setup(t);let attempts=0;
  s.options.openGuide=async()=>{
    attempts++;assert.equal((await s.store.load()).phase,'needs-user');
    throw new Error('LaunchServices unavailable');
  };
  const b=mock(['ready','ready','unknown']);
  assert.equal((await run(s,b)).phase,'needs-user');
  const request=await readRequest(s);
  assert.equal(request.status,'pending');assert.equal(request.guideOpen.status,'failed');
  assert.equal(request.guide.url,'https://example.org/guide');assert.equal(clicks(b),1);
  await run(s,mock([]));assert.equal(attempts,1);
  assert.match(await readFile(resolve(s.store.directory,'help-request.md'),'utf8'),/https:\/\/example.org\/guide/);
});
test('a pre-input timeout resumes observation then sends the input only once',async t=>{
  const s=await setup(t);const b=mock(['loading']);await run(s,b);
  assert.equal(clicks(b),0);assert.equal((await readRequest(s)).resumePhase,'before');
  await answerHelpRequest(s.store,'reobserve');
  const fixed=mock(['ready','ready','defeated','defeated']);
  assert.equal((await run(s,fixed)).phase,'finished');assert.equal(clicks(fixed),1);
});
test('two matching branches never choose the first arbitrarily',async t=>{
  const p=plan();p.steps[0].branches=[{id:'conflict',description:'ambiguous',when:{all:['defeated']},next:'attack'}];
  const s=await setup(t,p);const b=mock(['ready','ready','defeated']);
  assert.equal((await run(s,b)).phase,'needs-user');
  assert.equal((await readRequest(s)).errorCode,'AMBIGUOUS_RECORDED_BRANCH');assert.equal(clicks(b),1);
});
test('existing app can open a reply-bound resume plan, but cannot reuse it after completion',async t=>{
  const s=await setup(t);await run(s,mock(['ready','ready','unknown']));
  const answer=await answerHelpRequest(s.store,'reobserve');
  const input=JSON.parse(await readFile(answer.resumePlanPath,'utf8'));
  const loaded=await loadResumeRequest(input);
  assert.equal(loaded.runDirectory,s.store.directory);assert.deepEqual(loaded.originalPlan,s.record);
  await assert.rejects(loadResumeRequest({...input,requestId:'stale'}),/오래된/);
  await run(s,mock(['defeated','defeated']));
  await assert.rejects(loadResumeRequest(input),/오래된/);
});
test('cached copies of one frame do not satisfy two independent observations',async t=>{
  const s=await setup(t);const b=mock(['ready'],{sameFrame:true});
  assert.equal((await run(s,b)).phase,'needs-user');assert.equal(clicks(b),0);
});
test('a recorded loop is bounded and asks only after the documented visit limit',async t=>{
  const p=plan();p.steps[0].next='attack';p.steps[0].maxVisits=2;
  const s=await setup(t,p);const b=mock(['ready','ready','defeated','defeated','ready','ready','defeated','defeated','ready']);
  assert.equal((await run(s,b)).phase,'needs-user');assert.equal(clicks(b),2);
  assert.equal((await readRequest(s)).errorCode,'RECORDED_LOOP_LIMIT');
});
test('known survivor outcome asks instead of executing the exit step',async t=>{
  const p=plan();p.steps[0].branches=[{id:'survivor',description:'출구 이동 금지',when:{all:['enemy 3283']},ask:'적이 생존했습니다. 마무리 행동을 보완할까요?'}];
  p.steps.push(step('exit','ready-to-exit','victory'));
  const s=await setup(t,p);const b=mock(['ready','ready','enemy 3283']);
  const result=await run(s,b);
  assert.equal(result.phase,'needs-user');assert.equal(result.nextStep,0);assert.equal(clicks(b),1);
  assert.match((await readRequest(s)).reason,/적이 생존/);
});
test('a crash during dispatch requires observation and cannot silently replay the input',async t=>{
  const s=await setup(t);
  await writeFile(resolve(s.store.directory,'checkpoint.json'),JSON.stringify({recipe:s.recipe.id,digest:recipeDigest(s.recipe),nextStep:0,phase:'dispatching',visits:{attack:1},transitions:0}));
  const b=mock([]);assert.equal((await run(s,b)).phase,'needs-user');assert.equal(b.calls.length,0);
  await answerHelpRequest(s.store,'reobserve');
  const after=mock(['defeated','defeated']);assert.equal((await run(s,after)).phase,'finished');assert.equal(clicks(after),0);
});
test('stop answers stay stopped and stale answers cannot bypass a request',async t=>{
  const s=await setup(t);await run(s,mock(['ready','ready','unknown']));
  await assert.rejects(answerHelpRequest(s.store,'skip'),/선택/);
  await answerHelpRequest(s.store,'stop');
  const b=mock([]);assert.equal((await run(s,b)).phase,'stopped');assert.equal(b.calls.length,0);
  await assert.rejects(answerHelpRequest(s.store,'reobserve'),/일치/);
});
test('branch destinations and unbounded retries are rejected before game access',()=>{
  const p=plan();p.steps[0].branches=[{id:'bad',description:'bad',when:{all:['x']},next:'missing'}];
  assert.throws(()=>validateRecipe(p),/존재하지/);
  p.steps[0].branches=[];p.steps[0].maxVisits=999;
  assert.throws(()=>validateRecipe(p),/maxVisits/);
});
test('document catalog preserves coverage gaps and corrects the first-turn time skill',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../data/langrisser/playbooks.json',import.meta.url)));
  assert.equal(catalog.documentedStages,118);assert.equal(catalog.runnableStages,0);
  const stage=JSON.parse(await readFile(new URL('../data/langrisser/playbooks/main-1-4.json',import.meta.url)));
  assert.equal(stage.instructions.length,32);
  assert.match(stage.instructions.find(s=>s.turn===1 && s.actorKo==='프레시아').actionKo,/사용하지 않음/);
  assert.equal(inspectPlaybook(stage).ready,false);
});
test('documented menu snapshot compiles from local UI evidence without authorizing combat',async()=>{
  const input=JSON.parse(await readFile(new URL('../profiles/langrisser/main-1-4-details-recorded.json',import.meta.url)));
  const compiled=prepareExecutionInput(input);
  assert.equal(compiled.recipe.version,2);assert.equal(compiled.recipe.steps.length,2);
  const combat=structuredClone(input.record);combat.execution.recipe.executionScope='combat';
  combat.review.recipeSha256=recipeDigest(combat.execution.recipe);
  assert.throws(()=>compilePlaybook(combat),/출처/);
});
