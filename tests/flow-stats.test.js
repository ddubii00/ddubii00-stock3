'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../flow-stats');
const series = (value, count = 20) => Array.from({ length: count }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, dailyForeign: value }));

test('spot fallback converts trillion KRW to integer eok without rounding', () => {
  const result = flow.futuresStats({ unit: '조원', source: 'spot-fallback', series: series(0.35) });
  assert.equal(result.futuresMode, 'spot-fallback');
  assert.equal(result.futuresUnit, '억원');
  assert.deepEqual(result.futuresArray, [3500, 10500, 17500, 35000, 70000]);
  assert.equal(flow.futuresStats({ unit: '조원', source: 'spot-fallback', series: series(-0.35009, 1) }).futuresArray[0], -3500);
});

test('true futures retain contract quantities', () => {
  const result = flow.futuresStats({ unit: '계약', series: series(3000) });
  assert.equal(result.futuresMode, 'futures');
  assert.equal(result.futuresUnit, '계약');
  assert.deepEqual(result.futuresArray, [3000, 9000, 15000, 30000, 60000]);
});

test('missing payloads and partial windows are null, while real zero is preserved', () => {
  assert.equal(flow.futuresStats(null).futuresArray, null);
  assert.equal(flow.futuresStats({ unit: '계약', series: series(null) }).futuresArray, null);
  assert.deepEqual(flow.futuresStats({ unit: '계약', series: series(0, 1) }).futuresArray, [0, null, null, null, null]);
  assert.equal(flow.numericOrNull(null), null);
  assert.equal(flow.numericOrNull(''), null);
  assert.equal(flow.numericOrNull(undefined), null);
});

test('KIS contract windows never overwrite or fill a spot fallback row', () => {
  const core = { futuresMode: 'spot-fallback', futuresUnit: '억원', futuresArray: [3500, null, null, null, null], progsArray: null, programSource: 'unavailable' };
  const result = flow.mergeFlowStats(core, { futuresArray: [9999, 9999, 9999, 9999, 9999], futuresCoverageDays: 20 });
  assert.equal(result.futuresUnit, '억원');
  assert.equal(result.futuresMode, 'spot-fallback');
  assert.deepEqual(result.futuresArray, core.futuresArray);
  assert.equal(result.progsArray, null);
});

test('missing primary and fallback windows remain null rather than becoming zero', () => {
  assert.deepEqual(flow.mergeWindowValues([null, 0, null, null, null], 20, [100, null, null, null, null]), [100, 0, null, null, null]);
  assert.equal(flow.mergeFlowStats({}, null).futuresArray, null);
  assert.equal(flow.mergeFlowStats({}, null).progsArray, null);
});

test('program source follows the data actually used, including a core fallback', () => {
  const result = flow.mergeFlowStats({ progsArray: [50, null, null, null, null], programSource: 'Naver' }, { progsArray: [null, null, null, null, null], programSource: 'unavailable', programCoverageDays: 0 });
  assert.equal(result.programSource, 'Naver');
  assert.deepEqual(result.progsArray, [50, null, null, null, null]);
});
