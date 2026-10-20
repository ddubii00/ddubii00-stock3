'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'dashboard-data.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadFixture({ now = '2026-10-10T01:00:00Z', dates = ['20261008'], histories = {}, fail = false, onFetch } = {}) {
  const calls = [];
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = vm.createContext({
    module: { exports: {} },
    require: (id) => id.startsWith('.') ? require(path.join(root, id)) : require(id),
    Date: FixtureDate, Intl, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (onFetch) await onFetch(url);
      if (fail) throw new Error('source unavailable');
      let body;
      if (url.includes('/chart/domestic/index/')) {
        body = dates.map((date) => typeof date === 'string'
          ? { localDate: date, accumulatedTradingVolume: 10 }
          : date);
      } else if (url.includes('/domestic/market/stock/default')) {
        body = url.includes('KOSDAQ') ? [] : Object.keys(histories).map((code) => ({
          itemcode: code, itemname: code, nowPrice: '100', tradeAmount: '1000', marketSum: '100000'
        }));
      } else {
        const code = new URL(url).searchParams.get('code');
        body = { result: { items: histories[code] || [] } };
      }
      return { ok: true, json: async () => body };
    }
  });
  vm.runInContext(source, context);
  return { fetchFlows: context.module.exports.fetchInvestorTopFlows, calls };
}

function flow(date, foreign = '10', institution = '-20', price = '100') {
  return { localTradedAt: date, krx: { foreignNetVolume: foreign, organizationNetVolume: institution, closingPrice: price, changeRate: '1.5' } };
}

test('weekend after a weekday holiday uses the actual latest open date for every table', async () => {
  const fixture = loadFixture({ histories: {
    '005930': [flow('2026-10-08')],
    '000660': [flow('2026-10-08', '-30', '40')],
    '123456': [flow('2026-10-07', '999999', '999999')]
  } });
  const payload = await fixture.fetchFlows();
  assert.equal(payload.asOf, '2026-10-08');
  assert.equal(payload.latestOpenDate, '2026-10-08');
  assert.match(payload.note, /최근 개장일/);
  for (const key of ['foreignBuy', 'foreignSell', 'institutionBuy', 'institutionSell']) {
    assert.equal(payload[key].length, 1);
    assert.equal(payload[key][0].asOf, '2026-10-08');
    assert.notEqual(payload[key][0].code, '123456');
  }
});

test('weekday exchange holiday also uses the previous published session', async () => {
  const payload = await loadFixture({ now: '2026-10-09T03:00:00Z', histories: { '005930': [flow('2026-10-08')] } }).fetchFlows();
  assert.equal(payload.asOf, '2026-10-08');
});

test('opening day uses current session, sorted history and Seoul date across UTC midnight', async () => {
  const fixture = loadFixture({ now: '2026-10-07T16:00:00Z', dates: ['20261007', '20261008', '20261009'], histories: {
    '005930': [flow('2026-10-07', '999'), flow('2026-10-08', '20')]
  } });
  const payload = await fixture.fetchFlows();
  assert.equal(payload.asOf, '2026-10-08');
  assert.equal(payload.foreignBuy[0].foreignValue, 2000);
  assert.match(payload.note, /오늘 개장일/);
});

test('pre-open zero-volume index row does not displace the previous session', async () => {
  const payload = await loadFixture({ now: '2026-10-08T23:00:00Z', dates: [
    '20261008', { localDate: '20261009', accumulatedTradingVolume: 0 }
  ], histories: { '005930': [flow('2026-10-08')] } }).fetchFlows();
  assert.equal(payload.asOf, '2026-10-08');
});

test('every access refreshes the market universe and source even inside the previous cache TTL', async () => {
  const histories = { '005930': [flow('2026-10-08', '10')] };
  const fixture = loadFixture({ histories });
  const first = await fixture.fetchFlows();
  histories['005930'] = [flow('2026-10-08', '20')];
  const second = await fixture.fetchFlows();
  assert.equal(first.foreignBuy[0].foreignValue, 1000);
  assert.equal(second.foreignBuy[0].foreignValue, 2000);
  assert.equal(fixture.calls.filter((call) => call.url.includes('/stock/default')).length, 4);
  assert.equal(fixture.calls.filter((call) => call.url.includes('/trend?')).length, 2);
  assert.ok(fixture.calls.every((call) => call.options.cache === 'no-store'));
  assert.equal(second.requestedAt, '2026-10-10T01:00:00.000Z');
  assert.equal(second.fetchedAt, '2026-10-10T01:00:00.000Z');
});

test('simultaneous visitors perform independent fresh source requests', async () => {
  const fixture = loadFixture({ histories: { '005930': [flow('2026-10-08')] } });
  await Promise.all([fixture.fetchFlows(), fixture.fetchFlows()]);
  assert.equal(fixture.calls.filter((call) => call.url.includes('/trend?')).length, 2);
  assert.equal(fixture.calls.filter((call) => call.url.includes('/stock/default')).length, 4);
});

test('rankings contain only the correct buy/sell sign and stop at 20', async () => {
  const histories = {};
  for (let i = 1; i <= 45; i += 1) histories[String(i).padStart(6, '0')] = [flow('2026-10-08', String(i <= 22 ? i : -i), String(i <= 22 ? -i : i))];
  histories['999999'] = [flow('2026-10-08', null, '')];
  const payload = await loadFixture({ histories }).fetchFlows();
  for (const [key, valueKey, sign] of [
    ['foreignBuy', 'foreignValue', 1], ['foreignSell', 'foreignValue', -1],
    ['institutionBuy', 'institutionValue', 1], ['institutionSell', 'institutionValue', -1]
  ]) {
    assert.equal(payload[key].length, 20);
    assert.ok(payload[key].every((row) => row[valueKey] * sign > 0));
    assert.ok(payload[key].every((row, index, rows) => index === 0 || rows[index - 1][valueKey] * sign >= row[valueKey] * sign));
  }
});

test('unpublished current flows fall back to the most recent provided date without mixing sessions', async () => {
  const fixture = loadFixture({ now: '2026-10-20T03:00:00Z', dates: ['20261019', '20261020'], histories: {
    '005930': [flow('2026-10-16', '999999'), flow('2026-10-19', '30', '-40', '200')],
    '000660': [flow('2026-10-19', '-50', '60', '300')],
    '123456': [flow('2026-10-16', '999999', '999999')]
  } });
  const payload = await fixture.fetchFlows();
  assert.equal(payload.asOf, '2026-10-19');
  assert.equal(payload.latestOpenDate, '2026-10-20');
  assert.equal(payload.fallback, true);
  assert.match(payload.note, /2026-10-20.*미제공.*2026-10-19/);
  assert.equal(payload.foreignBuy[0].foreignValue, 6000);
  assert.equal(payload.foreignSell[0].foreignValue, -15000);
  for (const key of ['foreignBuy', 'foreignSell', 'institutionBuy', 'institutionSell']) {
    assert.equal(payload[key].length, 1);
    assert.equal(payload[key][0].asOf, payload.asOf);
  }
  assert.equal(fixture.calls.filter((call) => call.url.includes('/trend?')).length, 3);
});

test('valid current zero flows do not trigger historical fallback', async () => {
  const payload = await loadFixture({ histories: {
    '005930': [flow('2026-10-08', '0', '0'), flow('2026-10-07', '999', '-999')]
  } }).fetchFlows();
  assert.equal(payload.asOf, '2026-10-08');
  assert.equal(payload.fallback, false);
  for (const key of ['foreignBuy', 'foreignSell', 'institutionBuy', 'institutionSell']) assert.equal(payload[key].length, 0);
});

test('missing quantities and historical prices cannot select an unavailable session', async () => {
  const fixture = loadFixture({ dates: ['20261008'], histories: {
    '005930': [flow('2026-10-08', null, null), flow('2026-10-07', '999', '-999', null), flow('2026-10-06', '20', '-30')]
  } });
  const payload = await fixture.fetchFlows([{ code: '005930', price: 900, asOf: '2026-10-08' }]);
  assert.equal(payload.asOf, '2026-10-06');
  assert.equal(payload.foreignBuy[0].price, 100);
  assert.equal(payload.foreignBuy[0].foreignValue, 2000);
});

test('fresh data replaces the historical fallback on the next request and excludes future rows', async () => {
  const histories = { '005930': [flow('2026-10-09', '999'), flow('2026-10-07', '10')] };
  const fixture = loadFixture({ histories });
  const previous = await fixture.fetchFlows();
  assert.equal(previous.asOf, '2026-10-07');
  assert.equal(previous.fallback, true);
  histories['005930'].push(flow('2026-10-08', '20'));
  const latest = await fixture.fetchFlows();
  assert.equal(latest.asOf, '2026-10-08');
  assert.equal(latest.foreignBuy[0].foreignValue, 2000);
  assert.equal(latest.fallback, false);
});

test('empty histories and failed calendar queries remain explicit errors', async () => {
  await assert.rejects(loadFixture({ histories: { '005930': [] } }).fetchFlows(), /이전 거래일.*확인하지 못/);
  await assert.rejects(loadFixture({ fail: true }).fetchFlows(), /source unavailable/);
  await assert.rejects(loadFixture({ dates: [] }).fetchFlows(), /최근 개장일/);
});

test('browser renders the actual fallback date and its explanation', () => {
  const elements = { investorTopAsOf: {}, investorTopNote: {} };
  const tables = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    renderInvestorTopTable: (...args) => tables.push(args)
  });
  const start = html.indexOf('    function renderInvestorTopFlows(');
  const end = html.indexOf('    function colorizeResultText(', start);
  vm.runInContext(html.slice(start, end), context);
  context.renderInvestorTopFlows({
    asOf: '2026-10-19', latestOpenDate: '2026-10-20', fallback: true,
    note: '2026-10-20 수급 미제공으로 최근 제공 거래일(2026-10-19) 수급을 표시합니다.'
  });
  assert.match(elements.investorTopAsOf.textContent, /기준일 2026-10-19/);
  assert.doesNotMatch(elements.investorTopAsOf.textContent, /2026-10-20/);
  assert.match(elements.investorTopNote.textContent, /미제공.*2026-10-19/);
  assert.equal(tables.length, 4);
});

test('serverless endpoint bypasses CDN caching on normal visits and on errors', async () => {
  for (const fail of [false, true]) {
    let calls = 0;
    const context = vm.createContext({ module: { exports: {} }, require: (id) => id==='../access-control'?require('../access-control'):({
      fetchInvestorTopFlows: async () => { calls += 1; if (fail) throw new Error('unavailable'); return { asOf: '2026-10-08' }; }
    }) });
    vm.runInContext(fs.readFileSync(path.join(root, 'api/investor-top-flows.js'), 'utf8'), context);
    const headers = {};
    const res = { setHeader: (key, value) => { headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await context.module.exports({headers:{'x-stock3-password':'1222'}}, res);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(calls, 1);
    assert.equal(res.code, fail ? 500 : 200);
  }
});

test('initial browser fetch forces fresh data, prevents overlap and clears stale dates on failure', async () => {
  const elements = Object.fromEntries(['refreshInvestorTop20', 'investorTopAsOf', 'investorTopNote', 'foreignBuyTopBody', 'foreignSellTopBody', 'institutionBuyTopBody', 'institutionSellTopBody'].map((id) => [id, { textContent: 'old', innerHTML: '' }]));
  const calls = [];
  let reject;
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    fetchJsonWithRetry: (...args) => { calls.push(args); return new Promise((resolve, no) => { reject = no; }); },
    renderInvestorTopFlows: () => {}, escapeDashboard: String
  });
  const start = html.indexOf('    let investorTopRefreshing = false;');
  const end = html.indexOf("    document.getElementById('refreshDashboardBridge')", start);
  vm.runInContext(html.slice(start, end), context);
  const first = context.refreshInvestorTopFlows();
  await context.refreshInvestorTopFlows();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/investor-top-flows?refresh=1');
  assert.equal(calls[0][2].cache, 'no-store');
  reject(new Error('unavailable'));
  await first;
  assert.equal(elements.investorTopAsOf.textContent, '조회 실패');
  assert.equal(elements.refreshInvestorTop20.disabled, false);
  assert.match(elements.foreignBuyTopBody.innerHTML, /unavailable/);
});
