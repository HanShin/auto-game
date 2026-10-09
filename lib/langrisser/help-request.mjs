import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { helpGuide } from './help-guide.mjs';

export async function writeHelpRequest(store,{recipe,checkpoint,error,lastFrame}) {
  const step=recipe.steps[checkpoint.nextStep];
  const guide=helpGuide(recipe,checkpoint);
  const code=error.message.split(':')[0];
  const reasons={RECORDED_STATE_TIMEOUT:'화면을 여러 번 확인했지만 기록된 다음 상태를 찾지 못했습니다.',
    AMBIGUOUS_RECORDED_BRANCH:'여러 대응 조건이 동시에 일치해 다음 행동을 확정할 수 없습니다.',
    RECORDED_LOOP_LIMIT:'기록에 정한 재시도 횟수를 모두 사용했습니다.',
    GAME_NOT_FRONTMOST:'게임이 다른 창 뒤로 이동했습니다. 게임을 앞으로 가져온 뒤 다시 확인할 수 있습니다.',
    INTERRUPTED_INPUT:'이전 입력 중 실행이 끊겨 결과가 불명확합니다. 같은 입력을 반복하지 않고 결과 화면부터 확인해야 합니다.'};
  const question=code==='RECORDED_HELP' ? error.message.slice(error.message.indexOf(':')+1).trim() :
    step?.helpQuestion ?? '기록된 다음 행동을 확정할 수 없습니다. 화면을 정리한 뒤 현재 상태를 다시 확인할까요, 여기서 중지할까요?';
  const request={version:1,id:randomUUID(),status:'pending',createdAt:new Date().toISOString(),
    stageId:recipe.stageId,recipeId:recipe.id,recipeDigest:checkpoint.digest,stepId:step?.id,
    turn:step?.turn ?? guide?.turn ?? null,actor:step?.actorKo ?? guide?.actor ?? null,errorCode:code,reason:reasons[code] ?? error.message,
    guide,
    question,
    expected:checkpoint.resumePhase==='verify' ? {normal:step?.after,branches:step?.branches ?? []} : step?.before,
    lastScreenshot:lastFrame?.path ?? null,ocr:lastFrame?.text ?? [],
    resumePhase:checkpoint.resumePhase ?? 'before',
    choices:[{id:'reobserve',label:'현재 상태 다시 확인',effect:'새 화면에서 기록된 조건만 다시 대조. 결과 불명 입력을 반복하지 않음.'},
      {id:'stop',label:'여기서 중지',effect:'현재 게임 상태와 실행 기록 유지.'}]};
  await writeFile(resolve(store.directory,'help-request.json'),JSON.stringify(request,null,2)+'\n');
  const picture=request.lastScreenshot ? `\n![마지막 게임 화면](${request.lastScreenshot})\n` : '';
  const guideLink=guide ? `\n공략: [${guide.title}](${guide.url})${guide.position ? ` · 영상 ${guide.position}` : ''}${guide.section ? ` · ${guide.section}` : ''}\n` : '\n이 단계에 연결된 웹 공략 주소가 없습니다.\n';
  await writeFile(resolve(store.directory,'help-request.md'),`# 진행 확인 요청\n\n${request.question}\n\n- 스테이지: ${request.stageId}\n- 단계: ${request.stepId ?? '시작 전'}\n- 이유: ${request.reason}\n- 입력 재전송: 하지 않음\n${guideLink}${picture}\n현재 상태를 다시 확인하거나 여기서 중지할 수 있습니다. 새 전투 행동이 필요하면 먼저 공략 기록을 보완해야 합니다.\n`);
  await store.event({type:'needs-user',requestId:request.id,step:step?.id,reason:error.message});
  return request;
}

// The caller holds the same run lock used by execution. Replies never grant
// permission to skip a checkpoint or repeat an input with an unknown outcome.
export async function answerHelpRequest(store,choice) {
  if(!['reobserve','stop'].includes(choice)) throw new Error('선택은 reobserve 또는 stop이어야 합니다.');
  await store.init();
  try {
    const checkpoint=await store.load();
    const path=resolve(store.directory,'help-request.json');
    const request=JSON.parse(await readFile(path,'utf8'));
    if(checkpoint?.phase!=='needs-user' || request.status!=='pending' || checkpoint.helpRequest!==request.id || checkpoint.digest!==request.recipeDigest) throw new Error('현재 대기 중인 요청과 일치하지 않습니다.');
    checkpoint.phase=choice==='reobserve' ? 'resume-observation' : 'stopped';
    checkpoint.status=choice==='reobserve' ? 'ready-to-reobserve' : 'stopped';
    checkpoint.resumePhase=request.resumePhase;
    await store.save(checkpoint);
    request.status='answered';request.choice=choice;request.answeredAt=new Date().toISOString();
    await writeFile(path+'.tmp',JSON.stringify(request,null,2)+'\n');await rename(path+'.tmp',path);
    const resumePlanPath=choice==='reobserve' ? resolve(store.directory,'resume-plan.json') : null;
    if(resumePlanPath) await writeFile(resumePlanPath,JSON.stringify({format:'langrisser-resume-request',version:1,
      runDirectory:resolve(store.directory),requestId:request.id,recipeDigest:request.recipeDigest},null,2)+'\n');
    await store.event({type:'user-answer',requestId:request.id,choice});
    return {status:checkpoint.status,runDirectory:store.directory,resumePlanPath,note:'응답만 저장했습니다. 앱의 계획 실행에서 resume-plan.json을 선택하면 기존 실행을 관찰부터 재개합니다.'};
  } finally {await store.release();}
}

export async function loadResumeRequest(input) {
  if(input.format!=='langrisser-resume-request' || input.version!==1 || typeof input.runDirectory!=='string') throw new Error('잘못된 재개 요청입니다.');
  const directory=resolve(input.runDirectory);
  const read=async name=>JSON.parse(await readFile(resolve(directory,name),'utf8'));
  const checkpoint=await read('checkpoint.json'),request=await read('help-request.json');
  if(checkpoint.phase!=='resume-observation' || request.status!=='answered' || request.choice!=='reobserve' ||
    checkpoint.helpRequest!==input.requestId || request.id!==input.requestId || checkpoint.digest!==input.recipeDigest || request.recipeDigest!==input.recipeDigest) throw new Error('현재 응답과 일치하지 않는 오래된 재개 요청입니다.');
  return {runDirectory:directory,originalPlan:await read('plan-input.json')};
}
