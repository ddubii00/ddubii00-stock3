'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInvestorSnapshot,
  parseProgramCurrentRows,
  parseProgramDailyRows,
  sumWindows,
  pbmnToTrillion,
  pbmnToEok,
  INVESTOR_MARKETS,
} = require('../kis-flow-gateway');

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

test('unit helpers', () => {
  assert.equal(pbmnToTrillion('1000000'), 1);
  assert.equal(pbmnToEok('100'), 1);
});
