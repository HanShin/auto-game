export const normalize = s => String(s).normalize('NFKC').replace(/[\s·・]/gu, '').toLowerCase();

export function findText(frame, query) {
  const spec = typeof query === 'string' ? { text: query } : query;
  const expected = normalize(spec.text);
  if (!expected) return [];
  return (frame.text ?? []).filter(item => {
    if (item.confidence < (spec.confidence ?? 0.4)) return false;
    const actual = normalize(item.text);
    if (!(spec.exact ? actual === expected : actual.includes(expected))) return false;
    if (!spec.region) return true;
    const [x, y, w, h] = spec.region;
    const cx = item.box.x + item.box.width / 2, cy = item.box.y + item.box.height / 2;
    return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
  });
}

export function matches(frame, guard) {
  if (!guard || typeof guard !== 'object') return false;
  const { all = [], any = [], none = [] } = guard;
  if (!all.length && !any.length) return false;
  return all.every(q => findText(frame, q).length > 0)
    && (!any.length || any.some(q => findText(frame, q).length > 0))
    && none.every(q => findText(frame, q).length === 0);
}

export function targetPoint(frame, action) {
  if (action.text) {
    const targets = findText(frame, action.text);
    if (targets.length !== 1) throw new Error(`AMBIGUOUS_TARGET: ${JSON.stringify(action.text)} (${targets.length})`);
    const b = targets[0].box;
    return [b.x + b.width / 2, b.y + b.height / 2];
  }
  if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw new Error('INVALID_POINT');
  }
  return action.point;
}

export function classify(frame) {
  const has = q => findText(frame, q).length > 0;
  if (has('승리 조건') && has('첫 클리어 보상') && has('소모')) return 'stage-details';
  if (has('단서 노트') && has('월드')) return 'chapter-map';
  if (has({ text: 'SKIP', exact: true, region: [0.8, 0, 0.2, 0.2] })) return 'dialogue';
  if (has('턴 종료')) return 'battle';
  return 'unknown';
}
