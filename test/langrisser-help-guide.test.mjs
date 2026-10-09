import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { helpGuide,openWebGuide,openHelpGuideOnce } from '../lib/langrisser/help-guide.mjs';
import { RunStore } from '../lib/langrisser/runner.mjs';

test('the actual paused ninth-turn action selects its own video and timestamp, not the wiki fallback',async()=>{
  const record=JSON.parse(await readFile(new URL('../data/langrisser/playbooks/main-1-4.json',import.meta.url)));
  const instruction=record.instructions.find(a=>a.turn===9 && a.atSeconds===310.015);
  const recipe={sourceUrl:record.sources[0].url,executionRecord:record,steps:[{sourceActionId:instruction.id}]};
  const guide=helpGuide(recipe,{nextStep:0});
  assert.equal(guide.url,'https://www.taptap.cn/moment/760982472031734954');
  assert.equal(guide.position,'05:10');assert.equal(guide.turn,9);assert.equal(guide.actor,'네미아');
});
test('missing web evidence uses the recorded stage URL without transferring another source timestamp',()=>{
  const recipe={sourceUrl:'https://example.org/stage',steps:[{sourceActionId:'ui'}],executionRecord:{
    instructions:[{id:'ui',sourceId:'local',atSeconds:12}],sources:[{id:'local',evidencePath:'/tmp/local.json'}]}};
  const guide=helpGuide(recipe,{nextStep:0});
  assert.equal(guide.url,recipe.sourceUrl);assert.equal(guide.position,null);
  recipe.sourceUrl='file:///tmp/local.json';assert.equal(helpGuide(recipe,{nextStep:0}),null);
});
test('the Mac browser adapter passes a web URL as one argument without a shell',async()=>{
  const calls=[];
  const url='https://example.org/guide?q=%24%28literal%29&part=9';
  await openWebGuide(url,{launch:async(...args)=>calls.push(args)});
  assert.deepEqual(calls,[['/usr/bin/open',[url],{timeout:5000}]]);
  for(const invalid of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.org/guide','--help']) {
    await assert.rejects(openWebGuide(invalid,{launch:async(...args)=>calls.push(args)}),/웹 공략/);
  }
  assert.equal(calls.length,1);
});
test('one pending question can request a browser tab only once and only after the game stops',async t=>{
  const directory=await mkdtemp(resolve(tmpdir(),'help-guide-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new RunStore(directory),opened=[];
  const request={id:'question-1',status:'pending',guide:{url:'https://example.org/guide'}};
  await writeFile(resolve(directory,'help-request.json'),JSON.stringify(request));
  await store.save({phase:'verifying',helpRequest:request.id});
  await openHelpGuideOnce(store,request.id,async url=>opened.push(url));assert.equal(opened.length,0);
  await store.save({phase:'needs-user',helpRequest:request.id});
  await openHelpGuideOnce(store,request.id,async url=>opened.push(url));
  await openHelpGuideOnce(store,request.id,async url=>opened.push(url));
  await openHelpGuideOnce(store,'stale-question',async url=>opened.push(url));
  assert.deepEqual(opened,['https://example.org/guide']);
});
