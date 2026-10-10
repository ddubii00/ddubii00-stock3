'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function riskFixture({ missing = false, spread = 1 } = {}) {
  const rows = (count, close, extra = {}) => Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close, ...extra
  }));
  const inputs = {
    market: missing ? {} : { '^VIX': rows(5, 20), '^SOX': rows(6, 100), 'KRW=X': rows(6, 1300), US10Y: rows(6, 4), US2Y: rows(6, 4 - spread) },
    kospi: missing ? [] : rows(130, 3000, { turnover: 1000000, foreign: 0.1 * 1e12 }),
    breadth: missing ? null : { highCount: 0, lowCount: 0, latestTradeDate: '2026-06-01' },
  };
  const calls = [];
  const context = vm.createContext({
    module: { exports: {} }, __dirname: root, inputs, calls, setTimeout, clearTimeout, AbortController,
    console: { warn: () => {} },
    require: (id) => {
      if (id === './risk-score') return require('../risk-score');
      if (id === './breakout-data') return { fetchMarketBreadth: async () => inputs.breadth };
      if (id === 'path') return path;
      if (id === 'fs') return { promises: { readFile: async (file) => {
        assert.equal(file, path.join(root, 'data', 'vkospi.json'));
        return JSON.stringify({ source: 'VKOSPI spot', series: missing ? [] : rows(60, 20) });
      } } };
      throw new Error(`Unexpected require: ${id}`);
    },
    fetch: () => { throw new Error('Live network is forbidden in tests'); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'dashboard-data.js'), 'utf8') + `
    fetchMarketRows = async (symbol) => inputs.market[symbol] || [];
    fetchDaumMarketRows = async (market, count) => { calls.push({ market, count }); return inputs.kospi; };
    module.exports.fetchRiskScore = fetchRiskScore;
  `, context);
  return { run: context.module.exports.fetchRiskScore, calls };
}

test('risk fetch uses one 130-row KOSPI history for all three components', async () => {
  const fixture = riskFixture();
  const result = await fixture.run();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].count, 130);
  assert.equal(result.components.length, 7);
  assert.equal(result.coverage.available, 7);
  assert.equal(result.score, 50);
  for (const item of result.components) {
    assert.equal(item.available, true);
    assert.equal(item.contribution, item.normalized * item.weight * 50);
    assert.ok(item.point >= -1 && item.point <= 1);
  }
  assert.match(result.components[0].name, /VIX\/VKOSPI/);
});

test('10Y-2Y spread changes the displayed value but never changes the risk score', async () => {
  const positive = await riskFixture({ spread: 1 }).run();
  const negative = await riskFixture({ spread: -1 }).run();
  assert.equal(positive.score, negative.score);
  assert.equal(positive.components[1].point, negative.components[1].point);
  assert.notEqual(positive.components[1].value, negative.components[1].value);
});

test('missing upstream data produces null components and data-insufficient coverage', async () => {
  const result = await riskFixture({ missing: true }).run();
  assert.equal(result.score, null);
  assert.equal(result.state, '데이터부족');
  assert.equal(result.coverage.available, 0);
  for (const item of result.components) {
    assert.equal(item.available, false);
    assert.equal(item.point, null);
    assert.equal(item.contribution, null);
  }
});

test('52-week breadth is separate from 20-day breakouts and a valid zero is retained', async () => {
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(root, 'breakout-data.js'), 'utf8') + `
    fetchMarketRows = async (market) => market === 'KOSPI' ? [{ itemcode: '005930', highPrice: 105, lowPrice: 95, week52HighPrice: 200, week52LowPrice: 40 }] : [];
    fetchTradingViewRows = async () => [{ d: ['005930', '삼성전자', 100, 0, 105, 95, 100, 100, 150, 50, 300, 30] }];
    module.exports.fresh = fetchMarketBreadthFresh;
  `, context);
  const result = await context.module.exports.fresh();
  assert.equal(result.highCount, 0);
  assert.equal(result.lowCount, 0);
  assert.equal(result.high20Count, 1);
  assert.equal(result.low20Count, 1);
});
