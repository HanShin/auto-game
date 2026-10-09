// Manual reference only. This module calculates screen points; it never controls the game.
const finitePoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

export function calibrateGrid(observations, { minPitch = 65, maxPitch = 115, maxResidual = 8 } = {}) {
  if (!Array.isArray(observations) || observations.length < 2) throw new Error('At least two visible, identified tile centers are required');
  for (const o of observations) {
    if (!o.name || !finitePoint(o.grid) || !finitePoint(o.pixel)) throw new Error('Each anchor needs name, grid and pixel pairs');
  }
  const xMean = observations.reduce((s, o) => s + o.grid[0], 0) / observations.length;
  const yMean = observations.reduce((s, o) => s + o.grid[1], 0) / observations.length;
  const pxMean = observations.reduce((s, o) => s + o.pixel[0], 0) / observations.length;
  const pyMean = observations.reduce((s, o) => s + o.pixel[1], 0) / observations.length;
  let numerator = 0;
  let denominator = 0;
  for (const o of observations) {
    const dx = o.grid[0] - xMean;
    const dy = o.grid[1] - yMean;
    numerator += dx * (o.pixel[0] - pxMean) + dy * (o.pixel[1] - pyMean);
    denominator += dx * dx + dy * dy;
  }
  if (!denominator) throw new Error('Anchors must occupy different grid tiles');
  const pitch = numerator / denominator;
  if (pitch < minPitch || pitch > maxPitch) throw new Error(`Tile pitch ${pitch.toFixed(1)} px is outside the expected range`);
  const origin = [pxMean - pitch * xMean, pyMean - pitch * yMean];
  const errors = observations.map((o) => Math.hypot(o.pixel[0] - origin[0] - pitch * o.grid[0], o.pixel[1] - origin[1] - pitch * o.grid[1]));
  const worstResidual = Math.max(...errors);
  if (worstResidual > maxResidual) throw new Error(`Anchor mismatch ${worstResidual.toFixed(1)} px; re-identify actors or recalibrate after camera movement`);
  const anchors = Object.fromEntries(observations.map((o) => [o.name, { grid: [...o.grid], pixel: [...o.pixel] }]));
  if (Object.keys(anchors).length !== observations.length) throw new Error('Anchor names must be unique');
  return { pitch, origin, worstResidual, anchors };
}

export function projectFromActor(calibration, actor, offset, { visible = [0, 0, 1051, 821], margin = 20 } = {}) {
  if (!actor?.name || !finitePoint(actor.grid) || !finitePoint(offset)) throw new Error('Actor identity, current tile and relative offset are required');
  const observed = calibration.anchors[actor.name];
  if (!observed) throw new Error(`Current actor ${actor.name} must be an observed calibration anchor`);
  if (observed.grid[0] !== actor.grid[0] || observed.grid[1] !== actor.grid[1]) throw new Error('Actor moved since calibration; observe the new position and recalibrate');
  const grid = [actor.grid[0] + offset[0], actor.grid[1] + offset[1]];
  const pixel = grid.map((v, i) => Math.round(calibration.origin[i] + calibration.pitch * v));
  if (pixel[0] < visible[0] + margin || pixel[0] > visible[2] - margin || pixel[1] < visible[1] + margin || pixel[1] > visible[3] - margin) {
    throw new Error(`Projected tile ${grid} is offscreen or too near an edge; pan and recalibrate`);
  }
  return { grid, pixel, actor: actor.name };
}

export function checkObservedTarget(projected, observation, expectedName, { maxCenterError = 12 } = {}) {
  if (!observation?.name || !finitePoint(observation.pixel)) throw new Error('Target identity and observed tile center are required');
  if (!expectedName || observation.name !== expectedName) throw new Error(`Expected ${expectedName}, observed ${observation.name}; do not confirm`);
  const error = Math.hypot(projected.pixel[0] - observation.pixel[0], projected.pixel[1] - observation.pixel[1]);
  if (error > maxCenterError) throw new Error(`Target ${observation.name} differs by ${error.toFixed(1)} px; do not click`);
  return { ...projected, observedTarget: observation.name, centerError: error };
}
