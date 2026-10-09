import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './environment.mjs';
import { inspectPlaybook, renderPlaybook, recordDigest } from '../lib/langrisser/playbook.mjs';

const data=resolve(root,'data/langrisser');
const read=async name=>JSON.parse(await readFile(resolve(data,name),'utf8'));
const guides=await read('guides.json');
const puzzles=await read('puzzle-routes.json');
const overrides=await read('playbook-overrides.json');
const policy=await read('execution-policy.json');
await mkdir(resolve(data,'playbooks'),{recursive:true});
await mkdir(resolve(root,'docs/langrisser-playbooks'),{recursive:true});
const index=[];
const commonExceptions=[
  {whenKo:'잠깐의 화면 전환·인식 흔들림',thenKo:'새 화면을 정해진 시간 동안 재확인. 기본 입력 전 12초, 입력 후 20초. 같은 결과가 서로 다른 두 캡처에서 확인되면 계속 진행.'},
  {whenKo:'기록된 예외 결과와 일치',thenKo:'해당 분기를 자동 실행. 피해량 숫자가 달라도 다음 행동에 필요한 조건이 일치하면 계속 진행.'},
  {whenKo:'대응 조건 없음·여러 분기 동시 일치·재시도 한도 소진',thenKo:'입력 중단. 현재 화면·직전 단계·기대 결과를 저장하고 사용자에게 요청. 해당 행동의 공략 사이트를 한 번 열고 영상 시점도 표시.'},
  {whenKo:'입력 후 결과 불명',thenKo:'같은 클릭을 반복하지 않음. 사용자 응답 후에도 결과 화면 관찰부터 재개.'}
];
for(const stage of guides.stages) {
  const extra=overrides.stages[stage.id] ?? {};
  const puzzle=puzzles[stage.id];
  const instructions=[];
  if(puzzle?.actionsKo) puzzle.actionsKo.forEach((actionKo,i)=>instructions.push({id:`puzzle-${i+1}`,actionKo,section:`로컬 퍼즐 순서 ${i+1}`,sourceId:'wiki',verified:true,expectedKo:'기물 배치 화면 매핑 필요'}));
  else if(puzzle?.waves) puzzle.waves.forEach((wave,w)=>{
    if(Array.isArray(wave)) for(const [i,action] of wave.entries()) instructions.push({id:`wave-${w+1}-${i+1}`,phase:w+1,actorKo:action.ball,actionKo:action.moves.join(' → '),sourceId:'wiki',section:`퍼즐 ${w+1}단계`,verified:true,expectedKo:'기물 배치 화면 매핑 필요'});
    else instructions.push({id:`wave-${w+1}`,phase:w+1,actionKo:wave.moves.join(' → '),sourceId:'wiki',section:`퍼즐 ${w+1}단계`,verified:true,expectedKo:`기록된 행동력 ${wave.stamina}, 화면 매핑 필요`});
  });
  const record={format:'langrisser-playbook',version:1,id:`${stage.id}-record`,stageId:stage.id,title:stage.titleJa,
    summaryKo:stage.summaryKo,turnLimit:stage.turnLimit,
    objectives:{mode:'all-objectives',achievementCount:stage.achievementCount,treasureAvailability:stage.treasureAvailability,treasureDescription:stage.treasureJa ?? '미상'},
    sources:[{id:'wiki',label:'일본 위키',url:stage.sourceUrl,sha256:stage.sourceSha256}],
    instructions,exceptions:commonExceptions,
    review:{sequenceReviewed:false,screenMappingVerified:false,recipeSha256:null},execution:{recipe:null},
    gaps:[],...extra};
  if(extra.sources) record.sources=[{id:'wiki',label:'일본 위키',url:stage.sourceUrl,sha256:stage.sourceSha256},...extra.sources];
  if(extra.exceptions) record.exceptions=[...commonExceptions,...extra.exceptions];
  const review=inspectPlaybook(record);
  await writeFile(resolve(data,'playbooks',`${stage.id}.json`),JSON.stringify(record,null,2)+'\n');
  await writeFile(resolve(root,'docs/langrisser-playbooks',`${stage.id}.md`),renderPlaybook(record));
  index.push({stageId:stage.id,title:record.title,record:`data/langrisser/playbooks/${stage.id}.json`,document:`docs/langrisser-playbooks/${stage.id}.md`,sha256:recordDigest(record),instructionCount:record.instructions.length,...review});
}
const catalog={version:1,mode:'offline-recorded-actions',sourceCoverage:guides.coverage,
  documentedStages:index.length,stagesWithOrderedInstructions:index.filter(s=>s.instructionCount>0).length,
  runnableStages:index.filter(s=>s.ready).length,executionPolicy:policy.recordedExecution,stages:index};
await writeFile(resolve(data,'playbooks.json'),JSON.stringify(catalog,null,2)+'\n');
const summary=['# 문 너머 저편 — 저장된 공략·행동 기록','',
  `스테이지 기록 ${index.length}개 / 순서 기록이 있는 스테이지 ${catalog.stagesWithOrderedInstructions}개 / 실행 입력까지 준비된 스테이지 ${catalog.runnableStages}개`,'',
  '저장된 정보의 범위는 기존 위키 목차 118개다. 한국 서버 전체 목록 대조와 영상 155편의 전체 행동 전사는 미완료다. 자료가 없는 순서를 임의로 채우지 않는다.','',
  '[기록 작성·실행·사용자 요청 사용법](LANGRISSER-RECORDED-PLAY.md)','',
  '| 스테이지 | 기록 | 순서 항목 | 입력 준비 |','|---|---|---|---|',
  ...index.map(s=>`| ${s.stageId} · ${s.title} | [보기](langrisser-playbooks/${s.stageId}.md) | ${s.instructionCount} | ${s.ready?'준비됨':'준비 중'} |`),''];
await writeFile(resolve(root,'docs/LANGRISSER-GUIDES.md'),summary.join('\n'));
console.log(JSON.stringify({documentedStages:catalog.documentedStages,stagesWithOrderedInstructions:catalog.stagesWithOrderedInstructions,runnableStages:catalog.runnableStages},null,2));
