import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeBridge, buildBridge } from '../lib/langrisser/bridge.mjs';
import { classify } from '../lib/langrisser/recognition.mjs';
import { runRecipe, RunStore } from '../lib/langrisser/runner.mjs';
import { assertGuideExecution,recipeDigest } from '../lib/langrisser/guide-policy.mjs';
import { compilePlaybook, inspectPlaybook, prepareExecutionInput, recordDigest } from '../lib/langrisser/playbook.mjs';
import { answerHelpRequest,loadResumeRequest } from '../lib/langrisser/help-request.mjs';
import { openWebGuide } from '../lib/langrisser/help-guide.mjs';
import { completionPolicy, auditStageFrames, stageCompletion, campaignCompletion } from '../lib/langrisser/completion.mjs';
import { root, runtime } from './environment.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const directory = resolve(runtime, 'langrisser');
const out = value => console.log(JSON.stringify(value, null, 2));
const readData = async name => JSON.parse(await readFile(resolve(root, 'data/langrisser', name), 'utf8'));
async function auditCompletion(stageId, bridge) {
  const guides = await readData('guides.json');
  const stage = guides.stages.find(s => s.id === stageId);
  const profile = (await readData('completion-profiles.json')).profiles.find(p => p.stageId === stageId);
  if (!stage || !profile) throw new Error('해당 스테이지의 업적·상자 화면 매핑이 아직 없습니다.');
  const auditDir = resolve(directory, `audit-${stageId}-${Date.now()}`);
  await mkdir(auditDir, {recursive: true});
  const frames = [];
  for (let i = 0; i < 2; i++) {
    const frame = await bridge.request('capture', {path: resolve(auditDir, `frame-${i+1}.png`)});
    await writeFile(resolve(auditDir, `frame-${i+1}.json`), JSON.stringify(frame, null, 2));
    frames.push(frame);
  }
  const observation = auditStageFrames(stage, profile, frames);
  for (const evidence of observation.evidence) {
    evidence.sha256 = createHash('sha256').update(await readFile(evidence.path)).digest('hex');
  }
  await writeFile(resolve(auditDir, 'result.json'), JSON.stringify(observation, null, 2));
  const progressPath = resolve(root, 'data/langrisser/progress.json');
  const lock = await open(progressPath + '.lock', 'wx');
  try {
    const progress = await readData('progress.json');
    progress.version = 2;
    progress.completionPolicy = completionPolicy;
    progress.updatedAt = observation.observedAt;
    progress.stageStates = {...progress.stageStates, [stageId]: observation};
    const campaign = campaignCompletion(guides, progress);
    progress.nextStageId = campaign.next?.stageId ?? null;
    progress.nextStageTitleKo = campaign.next?.titleKo ?? null;
    progress.nextAction = campaign.next?.action ?? (campaign.complete ? 'complete' : 'reconcile-catalog');
    await writeFile(progressPath + '.tmp', JSON.stringify(progress, null, 2) + '\n');
    await rename(progressPath + '.tmp', progressPath);
  } finally {
    await lock.close();
    await unlink(progressPath + '.lock');
  }
  return {...stageCompletion(stage, observation), evidence: observation.evidence};
}
let bridge;
try {
  if (command === 'guides' || command === 'status' || command === 'objectives') {
    const data = JSON.parse(await readFile(resolve(root, 'data/langrisser/guides.json'), 'utf8'));
    if (command === 'status' || command === 'objectives') {
      const progress = JSON.parse(await readFile(resolve(root, 'data/langrisser/progress.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; }));
      const {stages, ...completion} = campaignCompletion(data, progress);
      if (command === 'objectives') out(args[0] ? stages.find(s => s.stageId === args[0]) ?? {error: '스테이지를 찾을 수 없습니다.'} : {completion, stages});
      else out({...data.coverage, completion, progress});
    }
    else if (args[0]) {
      const stage = data.stages.find(s => s.id === args[0]);
      if (!stage) throw new Error('스테이지를 찾을 수 없습니다.');
      out(stage);
    } else for (const s of data.stages) console.log(`${s.id}\t${s.titleJa}\t${s.executionStatus}`);
  } else if (command === 'audit') {
    if (!args[0]) throw new Error('확인할 스테이지 ID가 필요합니다.');
    bridge = new NativeBridge(await buildBridge());
    out(await auditCompletion(args[0], bridge));
  } else if (command === 'stop') {
    if (!args[0]) throw new Error('실행 디렉터리가 필요합니다.');
    await writeFile(resolve(args[0], 'STOP'), 'stop\n');
    console.log('다음 입력 전에 중지합니다.');
  } else if (command === 'playbooks') {
    if(args[0]) out(inspectPlaybook(await readData(`playbooks/${args[0]}.json`)));
    else {
      const {stages,...summary}=await readData('playbooks.json');out(summary);
    }
  } else if (command === 'compile') {
    if(!args[0] || !args[1]) throw new Error('compile <기록.json> <실행계획.json> 경로가 필요합니다.');
    const record=JSON.parse(await readFile(resolve(args[0]),'utf8'));
    const {recipe}=compilePlaybook(record);
    await writeFile(resolve(args[1]),JSON.stringify({format:'langrisser-recorded-plan',version:1,recordSha256:recordDigest(record),record},null,2)+'\n');
    out({status:'compiled',path:resolve(args[1]),steps:recipe.steps.length,note:'로컬 기록을 고정했습니다. 실제 전투 완주 검증은 별도입니다.'});
  } else if (command === 'request') {
    if(!args[0]) throw new Error('실행 기록 경로가 필요합니다.');
    out(JSON.parse(await readFile(resolve(args[0],'help-request.json'),'utf8')));
  } else if (command === 'answer') {
    if(!args[0] || !args[1]) throw new Error('answer <실행 기록 경로> <reobserve|stop> 형식입니다.');
    out(await answerHelpRequest(new RunStore(resolve(args[0])),args[1]));
  } else if (command === 'run' || command === 'resume') {
    if (!args[0]) throw new Error('실행 계획 JSON 경로가 필요합니다.');
    let originalPlan=JSON.parse(await readFile(command==='resume' ? resolve(args[0],'plan-input.json') : resolve(args[0]),'utf8'));
    let resumedDirectory=command==='resume' ? resolve(args[0]) : null;
    if(originalPlan.format==='langrisser-resume-request') {
      const resumed=await loadResumeRequest(originalPlan);
      originalPlan=resumed.originalPlan;resumedDirectory=resumed.runDirectory;
    }
    const {recipe,route}=prepareExecutionInput(originalPlan);
    if(command==='resume' && recipe.version!==2) throw new Error('resume 명령은 기록 실행(version 2) 계획에만 적용합니다.');
    const live = command==='resume' || args.includes('--live');
    const guidePolicy = await readData('execution-policy.json');
    const guideRoutes = (await readData('video-routes.json')).routes;
    if(route) guideRoutes.unshift(route);
    // Reject before activating the game or creating an input bridge.
    if (live) assertGuideExecution(recipe, {policy: guidePolicy, routes: guideRoutes});
    if (recipe.auditAfter === true && !(await readData('completion-profiles.json')).profiles.some(p => p.stageId === recipe.stageId)) throw new Error('업적·상자 완료 판정을 위한 화면 매핑이 없습니다.');
    const runIndex = args.indexOf('--run-dir');
    if (live && !resumedDirectory && (runIndex < 0 || !args[runIndex+1])) throw new Error('--live 실행에는 --run-dir 경로가 필요합니다.');
    const runDirectory=live ? resumedDirectory ?? resolve(args[runIndex+1]) : null;
    if(live && resumedDirectory) console.log(`기존 기록을 관찰부터 재개합니다: ${resumedDirectory}`);
    const previous=live && recipe.version===2 ? await new RunStore(runDirectory).load() : null;
    if(previous && previous.digest!==recipeDigest(recipe)) throw new Error('RECIPE_CHANGED: 실행 중이던 기록과 다른 계획입니다.');
    if(previous && ['needs-user','stopped','finished'].includes(previous.phase)) {
      out(previous);
      if(previous.phase==='needs-user') process.exitCode=2;
    } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    if (live) {
      bridge = new NativeBridge(await buildBridge());
      if (args.includes('--delay')) await sleep(5000, undefined, {signal: controller.signal});
      await promisify(execFile)(resolve(runtime, 'activate-game'), [], {signal: controller.signal});
    }
    const result = await runRecipe(recipe, {bridge, live, guidePolicy, guideRoutes, signal: controller.signal,
      originalPlan,openGuide:guidePolicy.recordedExecution?.openGuideOnHelp ? openWebGuide : undefined,
      store: live ? new RunStore(runDirectory) : undefined});
    if (live && recipe.auditAfter === true && result.phase==='finished') {
      result.completion = await auditCompletion(recipe.stageId, bridge);
      result.stageComplete = result.completion.complete;
      // A recipe ending successfully does not authorize advancing past missing objectives.
      if (!result.stageComplete) result.status = 'objectives-incomplete';
      await writeFile(resolve(runDirectory, 'completion.json'), JSON.stringify(result.completion, null, 2));
    }
    out(result);
    if(result.phase==='needs-user') process.exitCode=2;
    }
  } else if (['build', 'doctor', 'capture'].includes(command)) {
    const binary = await buildBridge();
    if (command === 'build') console.log(binary);
    else {
      bridge = new NativeBridge(binary);
      if (command === 'doctor') out(await bridge.request('doctor'));
      else {
        await mkdir(directory, {recursive: true});
        const frame = await bridge.request('capture', {path: resolve(directory, `screen-${Date.now()}.png`)});
        frame.state = classify(frame);
        await writeFile(resolve(directory, 'latest.json'), JSON.stringify(frame, null, 2));
        out(frame);
      }
    }
  } else {
    console.log(`맥 랑그릿사 도구\n  status | objectives [main-1-4] | guides [main-1-4]\n  playbooks [스테이지 ID]\n  compile <기록.json> <고정할 계획.json>\n  doctor | capture | build\n  audit <스테이지 ID>                   현재 상세 화면의 클리어·업적·상자 확인\n  run <계획.json>                       로컬 기록/구문 검증\n  run <계획.json> --live --run-dir <경로> [--delay]\n  request <실행 경로>                  막힌 상황·질문 보기\n  answer <실행 경로> reobserve|stop     응답 기록\n  resume <실행 경로>                   저장된 계획으로 관찰부터 재개\n  stop <실행 경로>\n공략 문서 갱신: node scripts/document-langrisser.mjs\n완료 기준: 전 스테이지 + 모든 업적 + 모든 상자/숨겨진 보물. 전체 자동 완주 계획은 아직 작성·검증 중입니다.`);
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { bridge?.close(); }
