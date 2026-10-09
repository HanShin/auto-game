import { createHash } from 'node:crypto';
import { validateRecipe } from './runner.mjs';
import { recipeDigest } from './guide-policy.mjs';

export const recordDigest=record=>createHash('sha256').update(JSON.stringify(record)).digest('hex');

export function inspectPlaybook(record) {
  const gaps=[...(record.gaps ?? [])];
  if(record.format!=='langrisser-playbook' || record.version!==1 || !record.id || !record.stageId) gaps.push('행동 기록 형식·식별자 누락');
  if(!record.instructions?.length) gaps.push('단계별 행동 미작성');
  if(!record.execution?.recipe) gaps.push('게임 화면을 누르는 실행 단계 미매핑');
  if(record.review?.sequenceReviewed!==true) gaps.push('행동 순서 검토 미완료');
  if(record.review?.screenMappingVerified!==true) gaps.push('한국어 화면·좌표 매핑 미완료');
  if(record.execution?.recipe) {
    try {
      validateRecipe(record.execution.recipe);
      if(record.execution.recipe.version!==2) gaps.push('기록 실행에는 version 2 계획이 필요함');
      if(!record.execution.recipe.guideRouteId) gaps.push('실행 경로 식별자 누락');
      if(record.execution.recipe.stageId!==record.stageId) gaps.push('기록과 실행 계획의 스테이지 불일치');
      if(record.review?.recipeSha256!==recipeDigest(record.execution.recipe)) gaps.push('검토한 실행 계획의 해시 불일치');
      for(const step of record.execution.recipe.steps.filter(s=>s.action.type!=='observe')) {
        const instruction=record.instructions?.find(a=>a.id===step.sourceActionId);
        const source=record.sources?.find(s=>s.id===instruction?.sourceId);
        let sourceValid=false;
        try {sourceValid=['https:','http:'].includes(new URL(source?.url).protocol);} catch {}
        const navigation=['menu','battle-entry'].includes(record.execution.recipe.executionScope);
        const localUI=navigation && source?.kind==='local-observation' && source.evidencePath && /^[a-f0-9]{64}$/.test(source.sha256 ?? '');
        if(!instruction || instruction.verified!==true || !(sourceValid || localUI) ||
          !(Number.isFinite(instruction.atSeconds) && instruction.atSeconds>=0 || typeof instruction.section==='string' && instruction.section.trim())) gaps.push(`${step.id}: 확인한 출처 행동·시점 누락`);
      }
    } catch(error) {gaps.push(error.message);}
  }
  return {stageId:record.stageId,ready:gaps.length===0,gaps:[...new Set(gaps)]};
}

// Compilation is entirely local. The frozen recipe embeds its reviewed source
// metadata so play does not depend on a browser, remote page or mutable index.
export function compilePlaybook(record) {
  const review=inspectPlaybook(record);
  if(!review.ready) throw new Error(`PLAYBOOK_NOT_READY: ${review.gaps.join(' / ')}`);
  const recipe=structuredClone(record.execution.recipe);
  recipe.executionRecord={id:record.id,sha256:recordDigest(record),title:record.title,
    instructions:record.instructions,sources:record.sources,exceptions:record.exceptions ?? []};
  const route={id:recipe.guideRouteId,stageId:record.stageId,status:'ready',sequenceReviewed:true,
    screenMappingVerified:true,unresolved:[],recipeSha256:recipeDigest(recipe),sources:record.sources,
    actions:record.instructions};
  return {recipe,route};
}

export function prepareExecutionInput(input) {
  if(input.format==='langrisser-recorded-plan') {
    if(input.version!==1 || input.recordSha256!==recordDigest(input.record)) throw new Error('PLAYBOOK_CHANGED: 저장된 공략 기록의 해시가 다릅니다. 다시 컴파일해야 합니다.');
    return compilePlaybook(input.record);
  }
  if(input.format==='langrisser-playbook') return compilePlaybook(input);
  return {recipe:input,route:null};
}

export function renderPlaybook(record) {
  const stage=inspectPlaybook(record);
  const lines=[`# ${record.stageId} · ${record.title}`,'',
    `기록 상태: ${stage.ready ? '입력 계획 준비됨 — 실제 완주 검증은 별도' : '준비 중'}`,'',
    record.summaryKo ?? '', '', '## 목표','',
    record.objectives?.mode==='menu-verification' ? '- 메뉴 왕복 입력 확인. 전투·수집 완료 검증이 아님.' : '- 클리어 + 모든 업적 + 모든 상자/숨겨진 보물',
    `- 업적 수: ${record.objectives?.achievementCount ?? '미상'}`,
    `- 보물: ${record.objectives?.treasureDescription ?? '미상'}`,
    `- 턴 제한: ${record.turnLimit ?? '미상'}`,'','## 행동 순서',''];
  if(record.coordinateConvention) lines.push(record.coordinateConvention,'');
  if(record.instructions?.length) {
    lines.push('| 순서 | 턴·대상 | 행동 | 확인할 결과 |','|---|---|---|---|');
    for(const [i,a] of record.instructions.entries()) lines.push(`| ${i+1} · ${a.id} | ${a.turn ?? '—'} · ${a.actorKo ?? '—'} | ${a.actionKo.replaceAll('|','/')} | ${(a.expectedKo ?? '세부 조건 미작성').replaceAll('|','/')} |`);
  } else lines.push('현재 자료에는 실행 가능한 전체 행동 순서가 없다. 위 전략 요약에서 임의로 클릭 계획을 생성하지 않는다.');
  lines.push('','## 미리 정한 예외 대응','');
  for(const rule of record.exceptions ?? []) lines.push(`- **${rule.whenKo}**: ${rule.thenKo}`);
  lines.push('','## 실행 준비에 남은 항목','',...(stage.gaps.length ? stage.gaps.map(g=>`- ${g}`) : ['없음. 실제 게임 완주 성공을 뜻하지는 않는다.']), '', '## 출처','');
  for(const source of record.sources ?? []) lines.push(`- [${source.label ?? source.id}](${source.url ?? source.evidencePath})${source.sha256 ? ` · 수집본 SHA256: ${source.sha256}` : ''}`);
  lines.push('','정상 진행 중에는 이 기록과 현재 화면만 대조한다. 정상 행동·기록된 분기에는 확인을 요청하지 않는다. 기록 밖의 결과가 지속되면 화면·직전 행동·이유를 저장해 한 번 요청하고 해당 공략 사이트를 함께 연다.','');
  return lines.join('\n');
}
