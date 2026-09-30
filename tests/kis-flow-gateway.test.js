'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInvestorSnapshot,
  parseProgramCurrentRows,
  parseProgramDailyRows,
  sumWindows,
  mergeWindowValues,
  pbmnToTrillion,
  pbmnToEok,
  INVESTOR_MARKETS,
  normalizeBackfillRows,
  captureMarketsForMinute,
} = require('../kis-flow-gateway');
const { normalizeRows } = require('../kis-flow-display');

test('backfill keeps only actual KIS minute rows for the requested session', () => {
  const rows = normalizeBackfillRows({ unit: '조원', source: 'kis-persisted', series: [
    { date: '2026-09-30 09:00', foreign: 0, institution: 0, individual: 0 },
    { date: '2026-09-30 10:00', foreign: -0.1, institution: 0.2, individual: -0.1 },
    { date: '2026-09-29 10:00', foreign: 2, institution: 2, individual: 2 },
    { date: '2026-09-30 11:00', foreign: null, institution: 1, individual: 1 },
  ] }, 'KOSPI', '2026-09-30');
  assert.deepEqual(rows.map((row) => row.date), ['2026-09-30 09:00', '2026-09-30 10:00']);
  assert.equal(normalizeBackfillRows({ unit: '조원', source: 'other', series: rows }, 'KOSPI', '2026-09-30').length, 0);
});

test('spot and futures have independent regular-session boundaries', () => {
  assert.deepEqual(captureMarketsForMinute(8 * 60 + 44, true), []);
  assert.deepEqual(captureMarketsForMinute(8 * 60 + 45, true), ['FUTURES']);
  assert.deepEqual(captureMarketsForMinute(9 * 60, true), ['KOSPI', 'KOSDAQ', 'FUTURES']);
  assert.deepEqual(captureMarketsForMinute(15 * 60 + 31, true), ['FUTURES']);
  assert.deepEqual(captureMarketsForMinute(15 * 60 + 45, true), ['FUTURES']);
  assert.deepEqual(captureMarketsForMinute(15 * 60 + 46, true), []);
  assert.deepEqual(captureMarketsForMinute(10 * 60, false), []);
});

test('futures minute rows retain 08:45 and 15:45 but spot rows do not', () => {
  const series = ['08:44', '08:45', '09:00', '15:30', '15:45', '15:46'].map((time) => ({ date: `2026-09-30 ${time}`, foreign: 1 }));
  const payload = { unit: '계약', source: 'kis-persisted', series };
  assert.deepEqual(normalizeBackfillRows(payload, 'FUTURES', '2026-09-30').map((row) => row.date.slice(11)), ['08:45', '09:00', '15:30', '15:45']);
  assert.deepEqual(normalizeRows(series, '2026-09-30', 'FUTURES').map((row) => row.date.slice(11)), ['08:45', '09:00', '15:30', '15:45']);
  assert.deepEqual(normalizeRows(series, '2026-09-30', 'KOSPI').map((row) => row.date.slice(11)), ['09:00', '15:30']);
});

test('official KIS market codes are used', () => {
  assert.deepEqual(INVESTOR_MARKETS.KOSPI, { market: 'KSP', subCode: '0001', unit: '조원' });
  assert.deepEqual(INVESTOR_MARKETS.KOSDAQ, { market: 'KSQ', subCode: '1001', unit: '조원' });
  assert.deepEqual(INVESTOR_MARKETS.FUTURES, { market: 'K2I', subCode: 'F001', unit: '계약' });
});

test('investor spot snapshot parses KIS pbmn fields', () => {
  const out = parseInvestorSnapshot({ output: [{
    frgn_ntby_tr_pbmn: '125000',
    orgn_ntby_tr_pbmn: '-50000',
    prsn_ntby_tr_pbmn: '-75000',
  }] }, 'KOSPI');
  assert.deepEqual(out, { foreign: 0.125, institution: -0.05, individual: -0.075 });
});

test('futures snapshot uses foreign net quantity', () => {
  assert.deepEqual(parseInvestorSnapshot({ output: [{ frgn_ntby_qty: '-3120' }] }, 'FUTURES'), { foreign: -3120 });
});

test('program current uses official body.output and converts to eok', () => {
  const rows = parseProgramCurrentRows({ output: [
    { bsop_hour: '100000', whol_smtn_ntby_tr_pbmn: '12300' },
    { bsop_hour: '100030', whol_smtn_ntby_tr_pbmn: '12400' },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].hhmm, '10:00');
  assert.equal(rows[1].value, 124);
});

test('program daily parser and window sums', () => {
  const rows = parseProgramDailyRows({ output: [
    { stck_bsop_date: '20260917', whol_smtn_ntby_tr_pbmn: '100' },
    { stck_bsop_date: '20260918', whol_smtn_ntby_tr_pbmn: '200' },
    { stck_bsop_date: '20260921', whol_smtn_ntby_tr_pbmn: '-50' },
  ] });
  assert.deepEqual(rows.map(r => r.value), [1, 2, -0.5]);
  assert.deepEqual(sumWindows(rows, [1, 3, 5]), [-0, 3, null]);
});

test('KIS futures windows retain an available daily fallback', () => {
  assert.deepEqual(
    mergeWindowValues([120, 240, null, null, null], 2, [100, 200, 300, 400, 500]),
    [120, 200, 300, 400, 500]
  );
});

test('unit helpers', () => {
  assert.equal(pbmnToTrillion('1000000'), 1);
  assert.equal(pbmnToEok('100'), 1);
});
