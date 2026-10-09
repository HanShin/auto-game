import { findText, matches, normalize } from './recognition.mjs';

export const completionPolicy = Object.freeze({
  mode: 'all-objectives',
  required: ['clear', 'achievements', 'treasures'],
  unknownIsComplete: false,
  revisitIncomplete: true,
});

function inRegion(item, region) {
  const b = item.box;
  if (!b || !Number.isFinite(item.confidence)) return false;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  return x >= region[0] && y >= region[1] && x <= region[0] + region[2] && y <= region[1] + region[3];
}

function counter(frame, region) {
  const candidates = (frame.text ?? []).filter(item => item.confidence >= 0.25 && inRegion(item, region))
    .map(item => ({item, match: /^(\d{1,2})\/(\d{1,2})$/.exec(normalize(item.text))}))
    .filter(x => x.match);
  if (candidates.length !== 1) return null;
  const {item, match} = candidates[0];
  const collected = Number(match[1]), total = Number(match[2]);
  if (collected > total || total > 20) return null;
  return {collected, total, confidence: item.confidence};
}

function agreedCounter(frames, region) {
  const readings = frames.map(frame => counter(frame, region));
  if (readings.some(x => !x)) return null;
  if (!readings.every(x => x.collected === readings[0].collected && x.total === readings[0].total)) return null;
  return {...readings[0], confidence: Math.min(...readings.map(x => x.confidence))};
}

// Read counts only inside the mapped stage dialog. Background map badges,
// stamina and a single OCR reading cannot provide completion evidence.
export function auditStageFrames(stage, profile, frames) {
  if (!profile || stage.id !== profile.stageId) throw new Error('AUDIT_MAPPING_MISSING: 스테이지 화면 매핑이 필요합니다.');
  if (!Array.isArray(frames) || frames.length < 2 || frames.some(f => !f.path)
      || new Set(frames.map(f => f.path)).size !== frames.length) throw new Error('AUDIT_NEEDS_TWO_FRAMES');
  for (const frame of frames) {
    const title = {text: profile.titleKo, exact: true, region: profile.titleRegion};
    if (findText(frame, title).length !== 1 || !matches(frame, profile.detailsGuard)) {
      throw new Error('AUDIT_WRONG_STAGE: 지정한 스테이지 상세 화면이 아닙니다.');
    }
  }
  const clear = frames.every(frame => matches(frame, profile.clearGuard));
  const achievements = agreedCounter(frames, profile.achievementRegion);
  const treasures = agreedCounter(frames, profile.treasureRegion);
  const conflicts = [];
  if (achievements && stage.achievementCount != null && achievements.total !== stage.achievementCount) conflicts.push('achievement-total-differs-from-guide');
  if (treasures && ((stage.treasureAvailability === 'none' && treasures.total !== 0)
      || (stage.treasureAvailability === 'present' && treasures.total === 0))) conflicts.push('treasure-total-differs-from-guide');
  return {stageId: stage.id, titleKo: profile.titleKo, observedAt: new Date().toISOString(),
    method: 'two-frame-ocr', evidence: frames.map(f => ({path: f.path, generation: f.generation})),
    clear, achievements, treasures, conflicts};
}

export function stageCompletion(stage, observation) {
  const valid = observation?.stageId === stage.id && observation?.method === 'two-frame-ocr'
    && Array.isArray(observation.evidence) && observation.evidence.length >= 2
    && observation.evidence.every(e => typeof e.path === 'string' && e.path)
    && new Set(observation.evidence.map(e => e.path)).size === observation.evidence.length;
  const reasons = [];
  if (!valid) return {stageId: stage.id, complete: false, action: 'audit', reasons: ['screen-evidence-missing']};
  if (observation.clear !== true) reasons.push('clear-not-confirmed');
  for (const key of ['achievements', 'treasures']) {
    const value = observation[key];
    if (!value || !Number.isInteger(value.total) || !Number.isInteger(value.collected)
        || value.total < 0 || value.collected < 0 || value.collected > value.total) reasons.push(`${key}-unknown`);
    else if (value.collected !== value.total) reasons.push(`${key}-remaining`);
  }
  reasons.push(...(observation.conflicts ?? []));
  if (observation.achievements && stage.achievementCount != null
      && observation.achievements.total !== stage.achievementCount) reasons.push('achievement-total-differs-from-guide');
  if (observation.treasures && ((stage.treasureAvailability === 'none' && observation.treasures.total !== 0)
      || (stage.treasureAvailability === 'present' && observation.treasures.total === 0))) reasons.push('treasure-total-differs-from-guide');
  const complete = reasons.length === 0;
  const action = complete ? 'complete' : reasons.some(r => r.endsWith('-remaining')) ? 'replay' : 'audit';
  return {stageId: stage.id, titleKo: observation.titleKo, complete, action, reasons: [...new Set(reasons)],
    clear: observation.clear === true, achievements: observation.achievements, treasures: observation.treasures};
}

export function campaignCompletion(guides, progress) {
  const stages = guides.stages.map(stage => stageCompletion(stage, progress.stageStates?.[stage.id]));
  const incomplete = stages.filter(s => !s.complete);
  const next = incomplete.find(s => s.stageId === progress.nextStageId && s.action === 'replay')
    ?? incomplete.find(s => s.action === 'replay')
    ?? incomplete.find(s => s.stageId === progress.nextStageId)
    ?? incomplete[0] ?? null;
  return {policy: completionPolicy, indexedStages: stages.length, fullCompletionVerified: stages.length - incomplete.length,
    incompleteIndexedStages: incomplete.length, uninspectedStages: stages.filter(s => s.reasons.includes('screen-evidence-missing')).length,
    catalogVerified: guides.coverage.catalogVerified === true,
    complete: stages.length > 0 && incomplete.length === 0 && guides.coverage.catalogVerified === true,
    next, stages};
}
