import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateGrid, projectFromActor, checkObservedTarget } from '../scripts/langrisser-grid-reference.mjs';

test('recalibration follows a camera shift and changed actor tile', () => {
  const before = calibrateGrid([
    { name: '이리스', grid: [0, 0], pixel: [525, 425] },
    { name: '레인폴즈', grid: [3, 1], pixel: [798, 516] },
    { name: '비라쥬', grid: [0, 1], pixel: [525, 516] },
  ]);
  assert.deepEqual(projectFromActor(before, { name: '이리스', grid: [0, 0] }, [4, 1]).pixel, [889, 516]);
  const after = calibrateGrid([
    { name: '이리스', grid: [4, 1], pixel: [616, 245] },
    { name: '레인폴즈', grid: [3, 1], pixel: [525, 245] },
    { name: '비라쥬', grid: [7, 2], pixel: [889, 336] },
  ]);
  assert.deepEqual(projectFromActor(after, { name: '이리스', grid: [4, 1] }, [-1, 2]).pixel, [525, 427]);
});

test('rejects misidentified anchors and offscreen or mismatched targets', () => {
  assert.throws(() => calibrateGrid([
    { name: '이리스', grid: [0, 0], pixel: [525, 425] },
    { name: '레인폴즈', grid: [1, 0], pixel: [798, 425] },
  ]), /outside the expected range/);
  const cal = calibrateGrid([
    { name: '이리스', grid: [0, 0], pixel: [525, 425] },
    { name: '레인폴즈', grid: [1, 0], pixel: [616, 425] },
  ]);
  assert.throws(() => projectFromActor(cal, { name: '이리스', grid: [0, 0] }, [0, -5]), /offscreen/);
  const p = projectFromActor(cal, { name: '이리스', grid: [0, 0] }, [1, 0]);
  assert.throws(() => projectFromActor(cal, { name: '이리스', grid: [1, 0] }, [1, 0]), /recalibrate/);
  assert.throws(() => checkObservedTarget(p, { name: '루크레치아', pixel: [616, 425] }, '서큐버스'), /do not confirm/);
  assert.throws(() => checkObservedTarget(p, { name: '서큐버스', pixel: [707, 425] }, '서큐버스'), /do not click/);
  assert.equal(checkObservedTarget(p, { name: '서큐버스', pixel: [615, 426] }, '서큐버스').observedTarget, '서큐버스');
});
