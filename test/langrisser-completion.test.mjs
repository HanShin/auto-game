import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditStageFrames, stageCompletion, campaignCompletion } from '../lib/langrisser/completion.mjs';
import { validateRecipe } from '../lib/langrisser/runner.mjs';

const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));
const guides = await read('../data/langrisser/guides.json');
const stage = guides.stages.find(s => s.id === 'main-1-4');
const profile = (await read('../data/langrisser/completion-profiles.json')).profiles.find(p => p.stageId === stage.id);
const fixture = await read('./fixtures/langrisser/stage-details-after-clear.json');
function frames() { return [1, 2].map(i => ({...structuredClone(fixture), path: `frame-${i}.png`, generation: i})); }
function setCount(fs, original, value) {
  for (const f of fs) f.text.find(t => t.text.replace(/\s/g, '') === original && t.box.y > .68 && t.box.y < .75).text = value;
  return fs;
}
function allCollected() {
  return auditStageFrames(stage, profile, setCount(setCount(frames(), '1/2', '2/2'), '0/1', '1/1'));
}

test('real post-clear frame is incomplete with achievement and treasure remaining', () => {
  const audit = auditStageFrames(stage, profile, frames());
  const result = stageCompletion(stage, audit);
  assert.equal(result.clear, true);
  assert.equal(result.complete, false);
  assert.equal(result.action, 'replay');
  assert.equal(result.achievements.collected, 1);
  assert.equal(result.treasures.collected, 0);
  assert.deepEqual(result.reasons, ['achievements-remaining', 'treasures-remaining']);
});

test('all counters and clear evidence are required, even if recipe finished', () => {
  const audit = allCollected();
  assert.equal(stageCompletion(stage, audit).complete, true);
  assert.equal(stageCompletion(stage, {...audit, clear: false}).complete, false);
  assert.equal(stageCompletion(stage, {...audit, treasures: null}).complete, false);
  assert.equal(stageCompletion(stage, {phase: 'finished', outcome: 'all-complete'}).complete, false);
});

test('different stage or achievement modal cannot be audited as stage details', () => {
  const fs = frames();
  fs[1].text.find(t => t.text === '섬의 손님').text = '다른 스테이지';
  assert.throws(() => auditStageFrames(stage, profile, fs), /AUDIT_WRONG_STAGE/);
  assert.equal(stageCompletion(stage, {...allCollected(), stageId: 'main-1-5'}).complete, false);
  const modal = frames();
  modal[0].text.push({text: '업적', confidence: 1, box: {x: .45, y: .24, width: .1, height: .04}});
  assert.throws(() => auditStageFrames(stage, profile, modal), /AUDIT_WRONG_STAGE/);
});

test('counter absence, ambiguity or conflicting OCR never becomes zero', () => {
  const fs = frames();
  fs[1].text = fs[1].text.filter(t => t.text !== '0/1');
  const missing = auditStageFrames(stage, profile, fs);
  assert.equal(missing.treasures, null);
  assert(stageCompletion(stage, missing).reasons.includes('treasures-unknown'));
  const conflicting = frames();
  setCount([conflicting[1]], '1/2', '2/2');
  assert.equal(auditStageFrames(stage, profile, conflicting).achievements, null);
  const duplicate = frames();
  duplicate[0].text.push(structuredClone(duplicate[0].text.find(t => t.text.replace(/\s/g, '') === '1/2' && t.box.y > .68)));
  assert.equal(auditStageFrames(stage, profile, duplicate).achievements, null);
});

test('background map counters cannot replace missing dialog counters', () => {
  const fs = frames();
  for (const f of fs) {
    f.text = f.text.filter(t => !(t.text.replace(/\s/g, '') === '1/2' && t.box.y > .68));
    f.text.push({text: '2/2', confidence: 1, box: {x: .3, y: .3, width: .05, height: .03}});
  }
  assert.equal(auditStageFrames(stage, profile, fs).achievements, null);
  assert.throws(() => auditStageFrames(stage, profile, [fs[0], fs[0]]), /AUDIT_NEEDS_TWO_FRAMES/);
});

test('source mismatch blocks completion and later guide changes invalidate stale audit', () => {
  const audit = allCollected();
  assert.equal(stageCompletion({...stage, achievementCount: 3}, audit).complete, false);
  assert.equal(stageCompletion({...stage, treasureAvailability: 'none'}, audit).complete, false);
});

test('missing source facts stay unknown; explicit none is zero', () => {
  for (const id of ['side3-8', 'main-3-8', 'main-5-1']) {
    const s = guides.stages.find(s => s.id === id);
    assert.equal(s.achievementCount, null);
    assert.equal(s.treasureAvailability, 'unknown');
    assert.equal(stageCompletion(s).complete, false);
  }
  assert.equal(guides.stages.find(s => s.id === 'main-1-1').achievementCount, 0);
});

test('campaign revisits remaining objectives before another stage and never assumes full catalog', () => {
  const partial = auditStageFrames(stage, profile, frames());
  const report = campaignCompletion(guides, {nextStageId: 'main-1-5', stageStates: {[stage.id]: partial}});
  assert.equal(report.next.stageId, stage.id);
  assert.equal(report.next.action, 'replay');
  const one = {stages: [stage], coverage: {catalogVerified: false}};
  const progress = {stageStates: {[stage.id]: allCollected()}};
  assert.equal(campaignCompletion(one, progress).fullCompletionVerified, 1);
  assert.equal(campaignCompletion(one, progress).complete, false);
  assert.equal(campaignCompletion({...one, coverage: {catalogVerified: true}}, progress).complete, true);
});

test('all-objective recipes require completion audit instead of relying on outcome label', async () => {
  const recipe = await read('../profiles/langrisser/main-1-4-audit.json');
  assert.doesNotThrow(() => validateRecipe(recipe));
  assert.throws(() => validateRecipe({...recipe, auditAfter: false}), /실제 수집 수/);
});
