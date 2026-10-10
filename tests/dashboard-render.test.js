'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function uiFixture() {
  const nodes = {};
  const flowCard = { title: {}, memo: {}, querySelector(selector) { return selector === '.title' ? this.title : this.memo; } };
  for (const id of ['scoreMethod', 'riskScorePanel', 'flowTableBody', 'flowAsOf', 'refreshFlow', 'note-foreign-futures', 'note-foreign-futures-minute']) {
    const card = id === 'refreshFlow' ? flowCard : { title: {}, querySelector() { return this.title; } };
    nodes[id] = { innerHTML: '', textContent: '', dataset: {}, closest: () => card };
  }
  const context = vm.createContext({ document: { getElementById: (id) => nodes[id] }, escapeDashboard: String });
  vm.runInContext(html.slice(html.indexOf('    function renderRiskScore('), html.indexOf('    async function renderDashboardBridge(')), context);
  vm.runInContext(html.slice(html.indexOf('    function setForeignFlowChartMode('), html.indexOf('    async function fetchStatsAndUpdateTables(')), context);
  return { context, nodes, flowCard };
}

test('missing score renders a dash and pending state instead of zero', () => {
  const { context, nodes } = uiFixture();
  context.renderRiskScore(null);
  assert.match(nodes.riskScorePanel.innerHTML, /score-number">-/);
  assert.match(nodes.riskScorePanel.innerHTML, /확인 중/);
  assert.doesNotMatch(nodes.riskScorePanel.innerHTML, /score-number">0</);
});

test('risk rendering distinguishes all five states and reports missing components', () => {
  const { context, nodes } = uiFixture();
  for (const [state, className] of [['우호', 'friendly'], ['중립', 'neutral'], ['경계', 'caution'], ['위험', 'risk'], ['데이터부족', 'insufficient']]) {
    context.renderRiskScore({ score: 40, state, coverage: { available: 6, total: 7, missing: ['flow'] }, components: [
      { key: 'flow', name: '외국인 현물 수급', weight: 0.2, point: null, value: null, available: false }
    ] });
    assert.ok(nodes.riskScorePanel.innerHTML.includes(`score-orb ${className}`));
    assert.match(nodes.riskScorePanel.innerHTML, /반영 6\/7/);
    assert.match(nodes.riskScorePanel.innerHTML, /결측: 외국인 현물 수급/);
    assert.match(nodes.riskScorePanel.innerHTML, /미반영/);
  }
});

test('flow UI displays null as a dash, zero as zero, and spot units without a contract signal', () => {
  const { context, nodes, flowCard } = uiFixture();
  context.renderFlowStats({ futuresMode: 'spot-fallback', futuresArray: [3500, 0, null, null, null], progsArray: null, programSource: 'unavailable' });
  assert.match(nodes.flowTableBody.innerHTML, /외국인 현물 순매수\(억원·선물 원천 폐지로 대체\)/);
  assert.match(nodes.flowTableBody.innerHTML, />0<\/td>/);
  assert.match(nodes.flowTableBody.innerHTML, />-<\/td>/);
  assert.doesNotMatch(flowCard.memo.textContent, /3,000/);
  assert.match(nodes['note-foreign-futures'].closest().title.textContent, /외국인 현물 수급\(대체\)/);
  context.renderFlowStats({ futuresMode: 'futures', futuresArray: [3000], progsArray: [0], programSource: 'KIS' });
  assert.match(nodes.flowTableBody.innerHTML, /외국인 선물 순매수\(계약\)/);
  assert.match(flowCard.memo.textContent, /±3,000/);
});

test('chart titles follow their own response mode even when the stats row is a spot fallback', () => {
  const { context, nodes } = uiFixture();
  nodes['note-foreign-futures-minute'].dataset.flowMode = 'futures';
  context.setForeignFlowChartMode('note-foreign-futures-minute', 'futures');
  context.renderFlowStats({ futuresMode: 'spot-fallback', programSource: 'unavailable' });
  assert.match(nodes['note-foreign-futures-minute'].closest().title.textContent, /외국인 선물 수급 분봉/);
});

test('HTML and server-injected scripts compile and the injected poll uses the same renderer', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const template = serverSource.match(/const kisFlowRefresh = (String\.raw`[\s\S]*?`);/)[1];
  const script = vm.runInNewContext(template).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  new vm.Script(script);
  assert.match(script, /window\.renderFlowStats\(json\)/);
  assert.doesNotMatch(html, /fearGreed|Fear & Greed/);
  assert.match(serverSource, /server\.listen\(PORT, '127\.0\.0\.1'/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies), ['ws']);
});

test('unit-check script only prints raw source values using a mocked request', async () => {
  const output = [];
  const context = vm.createContext({
    module: { exports: {} }, require: () => {}, AbortSignal,
    console: { log: (value) => output.push(value) },
    fetch: async () => ({ ok: true, json: async () => ({ data: [{ accTradePrice: '1234567', foreignStraightPurchasePrice: '-7654321' }] }) }),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'scripts/check-daum-units.js'), 'utf8'), context);
  await context.module.exports.main();
  assert.deepEqual(JSON.parse(output[0]), { accTradePrice: '1234567', foreignStraightPurchasePrice: '-7654321' });
});

test('display wrapper passes spot payloads through without touching persisted contract data', async () => {
  const payload = { ok: true, unit: '조원', source: 'spot-fallback', series: [] };
  const context = vm.createContext({
    module: { exports: {} }, __dirname: root, process: { env: {}, on: () => {} }, Buffer,
    require: (id) => {
      if (id === 'path') return path;
      if (id === 'fs') return { readFileSync: () => { throw new Error('Persisted data reads are forbidden in this test'); } };
      return {};
    },
    fixturePayload: payload,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'kis-flow-display.js'), 'utf8') + `
    internalRequest = async () => ({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(fixturePayload)) });
    module.exports.handleChart = handleChartRequest;
  `, context);
  let result;
  await context.module.exports.handleChart({}, { writeHead: () => {}, end: (body) => { result = JSON.parse(body); } }, { unit: '계약', storeKind: 'FUTURES', label: '선물' });
  assert.equal(result.unit, '조원');
  assert.equal(result.source, 'spot-fallback');
  assert.deepEqual(result.series, []);
});
