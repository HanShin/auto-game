import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

function webUrl(value) {
  try {
    const url=new URL(value);
    if(!['https:','http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {return null;}
}

export function helpGuide(recipe,checkpoint) {
  const step=recipe.steps[checkpoint.nextStep];
  const record=recipe.executionRecord;
  const instruction=record?.instructions?.find(item=>item.id===step?.sourceActionId);
  const source=record?.sources?.find(item=>item.id===instruction?.sourceId);
  const sourceUrl=webUrl(source?.url);
  const url=sourceUrl ?? webUrl(recipe.sourceUrl);
  if(!url) return null;
  const atSeconds=sourceUrl && Number.isFinite(instruction?.atSeconds) && instruction.atSeconds>=0 ? instruction.atSeconds : null;
  const position=atSeconds===null ? null : `${String(Math.floor(atSeconds/60)).padStart(2,'0')}:${String(Math.floor(atSeconds%60)).padStart(2,'0')}`;
  return {url,title:sourceUrl ? source.label ?? source.author ?? '해당 행동 공략' : '스테이지 공략',
    sourceId:sourceUrl ? source.id : null,atSeconds,position,
    section:sourceUrl ? instruction?.section ?? null : null,
    turn:step?.turn ?? instruction?.turn ?? null,actor:step?.actorKo ?? instruction?.actorKo ?? null};
}

export async function openWebGuide(url,{launch=promisify(execFile)}={}) {
  const validated=webUrl(url);
  if(!validated) throw new Error('유효한 웹 공략 주소가 없습니다.');
  // The user requested this behavior for the standalone Mac program. No shell
  // interpolation, application rebuild or additional macOS permission is needed.
  await launch('/usr/bin/open',[validated],{timeout:5000});
}

// Called only after the game checkpoint is parked in needs-user. Persist the
// attempt first: retries/restarts must not keep creating tabs for one question.
export async function openHelpGuideOnce(store,requestId,openGuide) {
  const path=resolve(store.directory,'help-request.json');
  const request=JSON.parse(await readFile(path,'utf8'));
  if(request.id!==requestId || request.status!=='pending' || !request.guide?.url || request.guideOpen?.attemptedAt || !openGuide) return request;
  const checkpoint=await store.load();
  if(checkpoint?.phase!=='needs-user' || checkpoint.helpRequest!==request.id) return request;
  const save=async()=>{
    await writeFile(path+'.tmp',JSON.stringify(request,null,2)+'\n');await rename(path+'.tmp',path);
  };
  request.guideOpen={status:'attempting',attemptedAt:new Date().toISOString()};
  await save();
  try {
    await openGuide(request.guide.url);
    request.guideOpen.status='open-requested';
  } catch(error) {
    request.guideOpen.status='failed';request.guideOpen.error=error.message;
  }
  await save();
  await store.event({type:'help-guide',requestId:request.id,url:request.guide.url,status:request.guideOpen.status});
  return request;
}
