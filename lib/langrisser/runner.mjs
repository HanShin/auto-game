import { mkdir, readFile, writeFile, rename, appendFile, open, unlink, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { matches, targetPoint } from './recognition.mjs';
import { assertGuideExecution } from './guide-policy.mjs';
import { writeHelpRequest } from './help-request.mjs';
import { openHelpGuideOnce } from './help-guide.mjs';

function validateGuard(g) {
  if (!g || ![g.all, g.any].some(a => Array.isArray(a) && a.length)) throw new Error('화면 확인 조건이 필요합니다.');
  for (const key of ['all', 'any', 'none']) {
    if (g[key] !== undefined && !Array.isArray(g[key])) throw new Error('잘못된 확인 조건');
    for (const q of g[key] ?? []) {
      const text = typeof q === 'string' ? q : q?.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('빈 화면 확인 문구');
      if (q.region && (!Array.isArray(q.region) || q.region.length !== 4 || !q.region.every(x => Number.isFinite(x) && x >= 0 && x <= 1))) throw new Error('잘못된 OCR 영역');
    }
  }
}
export function validateRecipe(recipe) {
  if (![1, 2].includes(recipe.version) || !recipe.id || !recipe.stageId || !recipe.sourceUrl) throw new Error('실행 계획 식별자와 출처가 필요합니다.');
  if (recipe.objectiveMode === 'all-objectives' && recipe.auditAfter !== true) throw new Error('모든 업적·상자 계획에는 종료 후 실제 수집 수 확인이 필요합니다.');
  if (!Array.isArray(recipe.steps) || !recipe.steps.length) throw new Error('실행 단계가 없습니다.');
  const ids = new Set();
  for (const step of recipe.steps) {
    if (!step.id || ids.has(step.id)) throw new Error('단계 ID 누락 또는 중복');
    ids.add(step.id);
    validateGuard(step.before);
    validateGuard(step.after);
    if (!['click', 'drag', 'observe'].includes(step.action?.type)) throw new Error('지원하지 않는 동작');
    if (step.action.type !== 'observe') {
      if (step.action.text) validateGuard({all: [step.action.text]});
      else targetPoint({}, step.action);
      if (step.action.type === 'drag') targetPoint({}, {point: step.action.to});
    }
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 120000)) throw new Error('timeoutMs 범위 오류');
    if (recipe.version === 2) {
      for (const [name,min,max] of [['beforeTimeoutMs',100,120000],['stableObservations',2,5],['maxVisits',1,10]]) {
        if (step[name] !== undefined && (!Number.isInteger(step[name]) || step[name]<min || step[name]>max)) throw new Error(`${name} 범위 오류`);
      }
      const branches = new Set();
      for (const branch of step.branches ?? []) {
        if (!branch.id || branch.id === 'expected' || branches.has(branch.id) || !branch.description) throw new Error('분기 식별자·설명 누락 또는 중복');
        branches.add(branch.id); validateGuard(branch.when);
        if ((typeof branch.next === 'string') === (typeof branch.ask === 'string') || (branch.ask!==undefined && !branch.ask.trim())) throw new Error('분기는 다음 단계 또는 비어 있지 않은 질문 중 하나가 필요합니다.');
      }
    } else if (step.branches || step.next !== undefined) throw new Error('분기는 version 2 계획에서만 지원합니다.');
  }
  if (recipe.version === 2) {
    for (const step of recipe.steps) {
      for (const next of [step.next, ...(step.branches ?? []).map(b=>b.next)]) {
        if (next !== undefined && next !== '$finish' && !ids.has(next)) throw new Error(`존재하지 않는 다음 단계: ${next}`);
      }
    }
  }
  return recipe;
}

export class RunStore {
  constructor(directory) { this.directory = directory; }
  async init() {
    await mkdir(this.directory, {recursive: true});
    this.lock = await open(resolve(this.directory, 'run.lock'), 'wx').catch(e => { throw new Error(`이미 실행 중이거나 종료 확인이 필요한 실행 기록이 있습니다: ${e.message}`); });
    await this.lock.writeFile(String(process.pid));
  }
  async release() { if (this.lock) { await this.lock.close(); await unlink(resolve(this.directory, 'run.lock')); this.lock = null; } }
  async save(value) {
    const path = resolve(this.directory, 'checkpoint.json');
    await writeFile(path + '.tmp', JSON.stringify(value, null, 2));
    await rename(path + '.tmp', path);
  }
  async load() {
    try { return JSON.parse(await readFile(resolve(this.directory, 'checkpoint.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async event(value) { await appendFile(resolve(this.directory, 'events.jsonl'), JSON.stringify({at: new Date().toISOString(), ...value}) + '\n'); }
  async stopped() { try { await access(resolve(this.directory, 'STOP')); return true; } catch { return false; } }
}

export async function runRecipe(recipe, { bridge, store, signal, guidePolicy, guideRoutes, originalPlan, openGuide, live = false, log = console.log, pollMs = 400 }) {
  validateRecipe(recipe);
  const digest = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  if (!live) return {status: 'validated-only', recipe: recipe.id, steps: recipe.steps.length, note: '구문 검증만 완료. 화면 적합성이나 완주 성공을 뜻하지 않음.'};
  assertGuideExecution(recipe, {policy: guidePolicy, routes: guideRoutes});
  if (recipe.version === 2) return runRecordedRecipe(recipe,{bridge,store,signal,log,pollMs,digest,originalPlan,openGuide,settings:guidePolicy?.recordedExecution});
  const permission = await bridge.request('doctor');
  if (!permission.screenRecording || !permission.accessibility || !permission.gameRunning) throw new Error('화면 기록·손쉬운 사용 권한과 실행 중인 게임이 필요합니다.');
  await store.init();
  let checkpoint;
  const checkStop = async () => {
    if (signal?.aborted || await store.stopped()) throw new Error('STOPPED: 입력을 중지했습니다.');
  };
  let serial = 0;
  const observe = async () => {
    await checkStop();
    const frame = await bridge.request('capture', {path: resolve(store.directory, `frame-${Date.now()}-${++serial}.png`)});
    await writeFile(resolve(store.directory, 'latest.json'), JSON.stringify(frame, null, 2));
    return frame;
  };
  try {
    const previous = await store.load();
    if (previous && previous.digest !== digest) throw new Error('실행 계획이 바뀌었습니다. 별도 실행 디렉터리가 필요합니다.');
    if (previous && ['dispatching', 'verifying', 'ambiguous'].includes(previous.phase)) throw new Error('AMBIGUOUS_CHECKPOINT: 이전 입력 결과를 화면에서 확인한 후 재개 위치를 지정해야 합니다.');
    checkpoint = previous ?? {recipe: recipe.id, digest, nextStep: 0, phase: 'ready'};
    if (checkpoint.phase === 'finished') return checkpoint;
    for (let i = checkpoint.nextStep; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      let frame = await observe();
      // The first Vision call can warm up models slowly. Re-observe before
      // considering input; the native bridge independently rejects old frames.
      if (frame.elapsedMs > 8000) frame = await observe();
      if (!frame.frontmost) throw new Error('GAME_NOT_FRONTMOST');
      if (!matches(frame, step.before)) throw new Error(`SCREEN_MISMATCH: ${step.id} 실행 전 조건 불일치`);
      await checkStop();
      checkpoint = {...checkpoint, nextStep: i, phase: 'dispatching', step: step.id};
      await store.save(checkpoint);
      await store.event({type: 'before', step: step.id, frame: frame.path});
      if (step.action.type !== 'observe') {
        await bridge.request(step.action.type, { generation: frame.generation,
          point: targetPoint(frame, step.action), to: step.action.to, durationMs: step.action.durationMs });
      }
      checkpoint.phase = 'verifying';
      await store.save(checkpoint);
      const deadline = Date.now() + (step.timeoutMs ?? 15000);
      let confirmed = false;
      while (Date.now() < deadline) {
        await sleep(pollMs, undefined, {signal});
        frame = await observe();
        if (matches(frame, step.after)) { confirmed = true; break; }
      }
      if (!confirmed) throw new Error(`POSTCONDITION_TIMEOUT: ${step.id}. 입력을 재전송하지 않았습니다.`);
      checkpoint = {...checkpoint, nextStep: i+1, phase: 'ready'};
      await store.save(checkpoint);
      await store.event({type:'verified', step:step.id, frame:frame.path});
      log(`${i+1}/${recipe.steps.length}: ${step.id}`);
    }
    checkpoint.phase = 'finished';
    // Completion applies only to this recipe, never to an unverified stage or campaign.
    checkpoint.outcome = recipe.outcome ?? 'recipe-only';
    checkpoint.stageComplete = false;
    await store.save(checkpoint);
    return checkpoint;
  } catch (e) {
    if (checkpoint) {
      checkpoint.error = e.message;
      if (['dispatching', 'verifying'].includes(checkpoint.phase)) checkpoint.phase = 'ambiguous';
      await store.save(checkpoint);
    }
    throw e;
  } finally { await store.release(); }
}

// No source fetching or dynamic action generation happens in the execution loop.
// A version 2 plan is a bounded graph of already documented inputs and outcomes.
async function runRecordedRecipe(recipe,{bridge,store,signal,log,pollMs,digest,originalPlan,openGuide,settings={}}) {
  const defaults={beforeTimeoutMs:settings.beforeTimeoutMs ?? 12000,afterTimeoutMs:settings.afterTimeoutMs ?? 20000,
    stableObservations:settings.stableObservations ?? 2,maxVisits:settings.defaultMaxVisitsPerStep ?? 1};
  for(const [key,min,max] of [['beforeTimeoutMs',100,120000],['afterTimeoutMs',100,120000],['stableObservations',2,5],['maxVisits',1,10]]) {
    if(!Number.isInteger(defaults[key]) || defaults[key]<min || defaults[key]>max) throw new Error(`RECORDED_CONFIG_INVALID: ${key}`);
  }
  await store.init();
  let checkpoint, lastFrame;
  let serial=0;
  const stop=async()=>{
    if(signal?.aborted || await store.stopped()) throw new Error('STOPPED: 입력을 중지했습니다.');
  };
  const capture=async()=>{
    await stop();
    lastFrame=await bridge.request('capture',{path:resolve(store.directory,`frame-${Date.now()}-${++serial}.png`)});
    await writeFile(resolve(store.directory,'latest.json'),JSON.stringify(lastFrame,null,2));
    if(!lastFrame.frontmost) throw new Error('GAME_NOT_FRONTMOST');
    return lastFrame;
  };
  const waitFor=async(candidates,timeoutMs,stable)=>{
    const deadline=Date.now()+timeoutMs;
    let lastChoice, lastIdentity, count=0, conflicting=false;
    do {
      const frame=await capture();
      const identity=frame.path ?? frame.generation;
      const found=frame.elapsedMs>8000 ? [] : candidates.filter(c=>matches(frame,c.when));
      conflicting=found.length>1;
      if(found.length===1 && identity!==undefined && identity!==lastIdentity) {
        count=lastChoice===found[0].id ? count+1 : 1;
        lastChoice=found[0].id;
        if(count>=stable) return found[0];
      } else if(found.length!==1 || found[0].id!==lastChoice) {count=0;lastChoice=undefined;}
      lastIdentity=identity;
      await sleep(pollMs,undefined,{signal});
    } while(Date.now()<deadline);
    throw new Error(conflicting ? 'AMBIGUOUS_RECORDED_BRANCH: 여러 대응 조건이 동시에 일치합니다.' : 'RECORDED_STATE_TIMEOUT: 정해진 시간 동안 기록된 화면 조건을 확인하지 못했습니다.');
  };
  const stepIndex=id=>id==='$finish' ? recipe.steps.length : recipe.steps.findIndex(s=>s.id===id);
  try {
    checkpoint=await store.load();
    if(checkpoint && checkpoint.digest!==digest) throw new Error('RECIPE_CHANGED: 기록이 바뀌었습니다. 새 실행 기록이 필요합니다.');
    if(checkpoint?.phase==='finished') return checkpoint;
    if(checkpoint?.phase==='needs-user') return checkpoint;
    if(checkpoint?.phase==='stopped') return checkpoint;
    if(checkpoint && ['dispatching','verifying'].includes(checkpoint.phase)) {
      // A crash can occur after an input was sent but before acknowledgement.
      checkpoint.resumePhase='verify';
      lastFrame=await readFile(resolve(store.directory,'latest.json'),'utf8').then(JSON.parse).catch(()=>undefined);
      throw new Error('INTERRUPTED_INPUT: 이전 입력 결과를 먼저 관찰해야 합니다. 입력을 재전송하지 않습니다.');
    }
    checkpoint ??= {recipe:recipe.id,digest,nextStep:0,phase:'ready',visits:{},transitions:0};
    checkpoint.status='running';
    await writeFile(resolve(store.directory,'recipe-snapshot.json'),JSON.stringify(recipe,null,2)+'\n');
    await writeFile(resolve(store.directory,'plan-input.json'),JSON.stringify(originalPlan ?? recipe,null,2)+'\n');
    const permission=await bridge.request('doctor');
    if(!permission.screenRecording || !permission.accessibility || !permission.gameRunning) throw new Error('GAME_UNAVAILABLE: 게임 실행 상태와 화면·입력 권한을 확인해 주세요.');
    while(checkpoint.nextStep<recipe.steps.length) {
      const step=recipe.steps[checkpoint.nextStep];
      const stable=step.stableObservations ?? defaults.stableObservations;
      const reobserve=checkpoint.phase==='resume-observation' && checkpoint.resumePhase==='verify';
      checkpoint.step=step.id;
      if(!reobserve) {
        checkpoint.resumePhase='before';
        await waitFor([{id:'before',when:step.before}],step.beforeTimeoutMs ?? defaults.beforeTimeoutMs,stable);
        if((checkpoint.visits[step.id] ?? 0)>=(step.maxVisits ?? defaults.maxVisits)) throw new Error('RECORDED_LOOP_LIMIT: 기록에 정한 재시도 횟수를 소진했습니다.');
        await stop();
        // Resolve ambiguous OCR targets before recording the input as in-flight.
        const point=step.action.type==='observe' ? undefined : targetPoint(lastFrame,step.action);
        checkpoint.visits[step.id]=(checkpoint.visits[step.id] ?? 0)+1;
        checkpoint.phase='dispatching';checkpoint.resumePhase='verify';
        await store.save(checkpoint);
        await store.event({type:'before',step:step.id,frame:lastFrame.path});
        if(step.action.type!=='observe') await bridge.request(step.action.type,{generation:lastFrame.generation,point,to:step.action.to,durationMs:step.action.durationMs});
      }
      checkpoint.phase='verifying';
      await store.save(checkpoint);
      const candidates=[{id:'expected',when:step.after,next:step.next},...(step.branches ?? [])];
      const outcome=await waitFor(candidates,step.timeoutMs ?? defaults.afterTimeoutMs,stable);
      await store.event({type:'outcome',step:step.id,branch:outcome.id,frame:lastFrame.path});
      if(outcome.ask) throw new Error(`RECORDED_HELP: ${outcome.ask}`);
      checkpoint.nextStep=outcome.next===undefined ? checkpoint.nextStep+1 : stepIndex(outcome.next);
      checkpoint.transitions++;checkpoint.phase='ready';checkpoint.resumePhase='before';
      delete checkpoint.error;
      await store.save(checkpoint);
      log(`${step.id}: ${outcome.id==='expected' ? '기록대로 완료' : outcome.description}`);
    }
    checkpoint.phase='finished';checkpoint.status='recipe-finished';checkpoint.outcome=recipe.outcome ?? 'recipe-only';checkpoint.stageComplete=false;
    await store.save(checkpoint);
    return checkpoint;
  } catch(error) {
    if(!checkpoint || error.message.startsWith('RECIPE_CHANGED')) throw error;
    if(signal?.aborted || error.message.startsWith('STOPPED')) {
      checkpoint.phase='stopped';checkpoint.error='STOPPED';await store.save(checkpoint);throw error;
    }
    const request=await writeHelpRequest(store,{recipe,checkpoint,error,lastFrame});
    checkpoint.phase='needs-user';checkpoint.status='needs-user';checkpoint.stageComplete=false;
    checkpoint.error=error.message;checkpoint.helpRequest=request.id;
    await store.save(checkpoint);
    log(`\n확인이 필요합니다: ${request.question}\n상황: ${request.reason}\n기록: ${resolve(store.directory,'help-request.md')}\n선택: 현재 상태 다시 확인 / 여기서 중지\n`);
    if(request.guide) {
      log(`공략: ${request.guide.url}${request.guide.position ? ` (영상 ${request.guide.position})` : ''}`);
      const presented=await openHelpGuideOnce(store,request.id,openGuide);
      if(presented.guideOpen?.status==='failed') log('공략 사이트를 자동으로 열지 못했습니다. 위 링크로 확인할 수 있습니다. 게임은 중단 상태를 유지합니다.');
    }
    return checkpoint;
  } finally {await store.release();}
}
