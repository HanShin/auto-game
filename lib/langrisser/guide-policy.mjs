import { createHash } from 'node:crypto';

export const recipeDigest = recipe => createHash('sha256').update(JSON.stringify(recipe)).digest('hex');

// A source URL alone is not evidence that a battle plan follows that source.
// Menu/entry plans must declare their limited scope; unknown plans are combat.
export function assertGuideExecution(recipe, { policy, routes = [] } = {}) {
  const inputs = recipe.steps.filter(s => s.action.type !== 'observe');
  if (!inputs.length) return;
  if (policy?.inputHold?.active) {
    throw new Error(`GUIDE_INPUT_HELD: ${policy.inputHold.reason}`);
  }
  if (policy?.requireRecordedPlan && (recipe.version!==2 || !recipe.executionRecord?.sha256)) {
    throw new Error('RECORDED_PLAN_REQUIRED: 먼저 문서화·검토한 기록을 컴파일한 계획을 선택해 주세요.');
  }
  if (policy?.allowedStageIds && !policy.allowedStageIds.includes(recipe.stageId)) {
    throw new Error('GUIDE_STAGE_NOT_AUTHORIZED: 현재 검증 대상 스테이지가 아닙니다.');
  }
  if (['menu', 'battle-entry'].includes(recipe.executionScope)) return;
  const route = routes.find(r => r.id === recipe.guideRouteId && r.stageId === recipe.stageId);
  if (!route || route.status !== 'ready' || route.unresolved?.length ||
      route.sequenceReviewed !== true || route.screenMappingVerified !== true ||
      route.recipeSha256 !== recipeDigest(recipe)) {
    throw new Error('GUIDE_NOT_READY: 출처 행동 순서와 화면 매핑을 검증한 전투 계획이 필요합니다.');
  }
  for (const step of inputs) {
    const action = route.actions?.find(a => a.id === step.sourceActionId);
    const source = route.sources?.find(s => s.id === action?.sourceId);
    let validUrl = false;
    try { validUrl = ['https:', 'http:'].includes(new URL(source?.url).protocol); } catch {}
    const locator = Number.isFinite(action?.atSeconds) && action.atSeconds >= 0 ||
      typeof action?.section === 'string' && action.section.trim().length > 0;
    if (!validUrl || action?.verified !== true || !locator) {
      throw new Error(`GUIDE_STEP_UNVERIFIED: ${step.id}의 출처 시점/문단 확인이 필요합니다.`);
    }
  }
}
