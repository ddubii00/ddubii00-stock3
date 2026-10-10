'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../risk-score');
const filled = (value) => Object.fromEntries(Object.keys(risk.WEIGHTS).map((key) => [key, value]));

test('weights sum to one and the method is generated from the actual weights', () => {
  assert.ok(Math.abs(Object.values(risk.WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  for (const [key, weight] of Object.entries(risk.WEIGHTS)) assert.ok(risk.method().includes(`${risk.NAMES[key]} ${Math.round(weight * 100)}%`));
});

test('all missing data is degraded, without a fabricated neutral score', () => {
  const result = risk.combine(filled(null));
  assert.equal(result.score, null);
  assert.equal(result.state, '데이터부족');
  assert.equal(result.degraded, true);
  assert.equal(result.coverage.available, 0);
  assert.equal(result.coverage.total, 7);
  assert.equal(result.coverage.weightCovered, 0);
  assert.equal(result.coverage.missing.length, 7);
});

test('missing components are excluded and remaining weights are renormalized', () => {
  const result = risk.combine({ ...filled(null), volatility: 1, ratesFx: -1 });
  assert.equal(result.score, 63); // 50 + 50 * (0.25 - 0.15) / 0.40
  assert.equal(result.coverage.weightCovered, 0.4);
  assert.equal(result.coverage.available, 2);
  assert.equal(result.degraded, true);
});

test('coverage threshold is inclusive and zero is available data', () => {
  const result = risk.combine({ ...filled(null), volatility: 0, ratesFx: 0, flow: 0 });
  assert.equal(result.coverage.weightCovered, 0.6);
  assert.equal(result.degraded, false);
  assert.equal(result.score, 50);
  assert.equal(result.state, '중립');
});

test('all seven neutral components produce 50', () => {
  const result = risk.combine(filled(0));
  assert.equal(result.score, 50);
  assert.equal(result.coverage.available, 7);
  assert.equal(result.degraded, false);
});

test('state cuts distinguish friendly, neutral, caution and risk', () => {
  for (const [score, state] of [[65, '우호'], [64, '중립'], [45, '중립'], [44, '경계'], [30, '경계'], [29, '위험']]) {
    assert.equal(risk.combine(filled((score - 50) / 50)).state, state);
  }
});

test('VIX normalization and resulting score are monotone as volatility rises', () => {
  let previous = 101;
  for (let vix = 5; vix <= 45; vix += 0.1) {
    const point = risk.normalizeVix(Array(5).fill(vix));
    const score = risk.combine({ ...filled(0), volatility: point }).score;
    assert.ok(score <= previous);
    previous = score;
  }
});

test('VIX 19.9 to 20.1 does not cause a step of three or more score points', () => {
  const score = (vix) => risk.combine({ ...filled(0), volatility: risk.normalizeVix(Array(5).fill(vix)) }).score;
  assert.ok(Math.abs(score(19.9) - score(20.1)) < 3);
});

test('anchors interpolate and clamp rather than extending scores past bounds', () => {
  assert.equal(risk.normalizeVix(Array(5).fill(13)), 1);
  assert.equal(risk.normalizeVix(Array(5).fill(18)), 0.25);
  assert.equal(risk.normalizeVix(Array(5).fill(100)), -1);
  assert.equal(risk.combine(filled(999)).score, 100);
  assert.equal(risk.combine(filled(-999)).score, 0);
  assert.equal(risk.normalizeVix([13, 13, null, 13, 13]), null);
});

test('VKOSPI needs 60 observations and volatility averages only available inputs', () => {
  assert.equal(risk.normalizeVkospi(Array(59).fill(20)), null);
  assert.equal(risk.normalizeVkospi(Array(60).fill(20)), 0);
  assert.equal(risk.normalizeVolatility(Array(5).fill(13), []), 1);
  assert.equal(risk.normalizeVolatility([], Array(60).fill(20)), 0);
  assert.equal(risk.normalizeVolatility(Array(5).fill(13), Array(60).fill(20)), 0.5);
  const increasing = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.ok(risk.normalizeVkospi(increasing) < -0.9);
});

test('rates/FX use five trading-day cumulative changes and ignore spread', () => {
  assert.ok(Math.abs(risk.normalizeRatesFx([4, 4, 4, 4, 4, 4.2], [100, 100, 100, 100, 100, 102]) + 1) < 1e-12);
  assert.equal(risk.normalizeRatesFx(Array(6).fill(4), Array(6).fill(100)), 0);
  assert.equal(risk.normalizeRatesFx([], []), null);
  assert.equal(risk.normalizeRatesFx(Array(6).fill(4), []), 0);
});

test('flow uses 60 rolling five-day sums and is invariant to the monetary unit', () => {
  assert.equal(risk.normalizeFlow(Array(63).fill(0)), null);
  assert.equal(risk.normalizeFlow(Array(64).fill(0)), 0);
  assert.equal(risk.normalizeFlow(Array(64).fill(0.1)), 0);
  const values = Array.from({ length: 100 }, (_, i) => (i % 9) - 4);
  assert.ok(Math.abs(risk.normalizeFlow(values) - risk.normalizeFlow(values.map((x) => x * 1e12))) < 1e-12);
  assert.equal(risk.normalizeFlow([...Array(64).fill(0), null]), null);
  assert.equal(risk.normalizeFlow([...Array(95).fill(0), ...Array(5).fill(1000)]), 1);
});

test('breadth uses 52-week counts and smoothing, including valid zero breakouts', () => {
  assert.equal(risk.normalizeBreadth(0, 0), 0);
  assert.equal(risk.normalizeBreadth(20, 0), 2 / 3);
  assert.equal(risk.normalizeBreadth(null, 0), null);
  assert.equal(risk.normalizeBreadth(-1, 0), null);
});

test('trend needs MA60 and averages bounded price-position/return measures', () => {
  assert.equal(risk.normalizeTrend(Array(59).fill(100)), null);
  assert.equal(risk.normalizeTrend(Array(60).fill(100)), 0);
  assert.equal(risk.normalizeTrend(Array.from({ length: 100 }, (_, i) => i + 1)), 1);
  assert.equal(risk.normalizeTrend(Array.from({ length: 100 }, (_, i) => 101 - i)), -1);
});

test('SOX uses six closes for a full five-day cumulative return', () => {
  assert.equal(risk.normalizeSox(Array(5).fill(100)), null);
  assert.ok(Math.abs(risk.normalizeSox([100, 100, 100, 100, 100, 103]) - 1) < 1e-12);
  assert.equal(risk.normalizeSox([100, 100, 100, 100, 100, 90]), -1);
});

test('liquidity combines turnover strength with price direction and preserves missingness', () => {
  const turnover = [...Array(15).fill(100), ...Array(5).fill(1000)];
  assert.equal(risk.normalizeLiquidity(turnover, [100, 100, 100, 100, 100, 103]), 1);
  assert.equal(risk.normalizeLiquidity(turnover, [100, 100, 100, 100, 100, 97]), -1);
  assert.equal(risk.normalizeLiquidity(Array(20).fill(100), Array(6).fill(100)), 0);
  assert.equal(risk.normalizeLiquidity(Array(19).fill(100), Array(6).fill(100)), null);
  assert.equal(risk.normalizeLiquidity(Array(20).fill(0), Array(6).fill(100)), null);
});
