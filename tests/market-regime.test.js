'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../market-regime');
const view = require('../market-regime-view');
const NOW = '2026-10-19T12:00:00Z';
const flat = (n, price = 100) => Array(n).fill(price);
function bars(closes) {
  let day = new Date('2024-01-02T00:00:00Z');
  return closes.map((close) => {
    while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
    const row = { date: day.toISOString().slice(0, 10), close, high: close, low: close };
    day.setUTCDate(day.getUTCDate() + 1);
    return row;
  });
}
const analyze = (closes, market = 'KOSPI') => engine.analyze(bars(closes), market, { now: NOW });
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), values };
}

test('insufficient/invalid observations never invent allocation targets', () => {
  for (const input of [[], bars(flat(120)), [{date: '2024-13-01', close: 100}, {date: '2024-02-30', close: 100}, {date: '2024-01-02', close: null}]]) {
    const result = engine.analyze(input, 'KOSPI', { now: NOW });
    assert.equal(result.key, 'pending');
    assert.equal(result.cash, null);
    assert.equal(result.credit, null);
    assert.equal(result.exposure, null);
  }
});

test('super bull beats overlapping strong/general/sideways rules; breakout excludes today', () => {
  const increasing = Array.from({length: 160}, (_, i) => 100 + i / 10);
  const result = analyze(increasing);
  assert.equal(result.key, 'superBull');
  assert.deepEqual([result.cash, result.credit, result.exposure], [0, 30, 130]);
  assert.equal(result.conditions.find((r) => r.key === 'bull').met, true);
  const equalHigh = analyze([...increasing, increasing.at(-1)]);
  assert.equal(equalHigh.key, 'strongBull');
  assert.equal(equalHigh.credit, 15);
  assert.equal(equalHigh.metrics.breakout, false);
});

test('general rise and sideways map to the specified targets independently', () => {
  const general = analyze([...flat(90), ...flat(30, 90), 97]);
  assert.equal(general.key, 'bull');
  assert.equal(general.credit, 0);
  const sideways = analyze(flat(121));
  assert.equal(sideways.key, 'sideways');
  assert.deepEqual([sideways.cash, sideways.credit, sideways.exposure], [10, 0, 90]);
});

test('20-day price range 8% and MA20 five-day slope 1% boundaries are inclusive', () => {
  const rows = bars(flat(121)).map((row) => ({...row, high: 108}));
  assert.equal(engine.analyze(rows, 'KOSPI', {now: NOW}).key, 'sideways');
  rows.forEach((row) => { row.high = 108.001; });
  assert.equal(engine.analyze(rows, 'KOSPI', {now: NOW}).key, 'pending');
  const slope = analyze([...flat(121), ...flat(5, 104)]);
  assert.ok(Math.abs(slope.metrics.slope20 - 1) < 1e-9);
  assert.equal(slope.conditions.find((r) => r.key === 'sideways').met, true);
});

test('decline requires two closes strictly below MA20; equality breaks the streak', () => {
  assert.equal(analyze([...flat(121), 99]).key, 'sideways');
  assert.equal(analyze([...flat(121), 99, 98]).key, 'decline1');
  const equal = analyze(flat(123));
  assert.equal(equal.metrics.below20, 0);
  assert.equal(equal.metrics.above20, 0);
});

test('decline 2 outranks decline 1 at -10% and accepts a falling five-day MA20', () => {
  const result = analyze([...flat(121), 99, 90]);
  assert.equal(result.metrics.below20, 2);
  assert.equal(result.key, 'decline2');
  assert.deepEqual([result.cash, result.credit], [40, 0]);
  assert.equal(analyze([...flat(121), 99, 90.001]).key, 'decline1');
});

test('each exact drawdown threshold maps to its cash target and outranks decline', () => {
  for (const [price, stage, cash] of [[80,20,30],[70,30,20],[60,40,10],[50,50,5]]) {
    const result = analyze([...flat(121), price]);
    assert.equal(result.key, `drawdown${stage}`);
    assert.equal(result.cash, cash);
    assert.equal(result.credit, 0);
    assert.deepEqual(result.newStages, engine.RULES.stages.filter((n) => n <= stage));
    assert.equal(result.execution, '신호 확정 후 다음 거래일');
  }
  assert.equal(analyze([...flat(121), 80.001]).key, 'decline2');
});

test('same-cycle rebounds/retests never repeat stages or move the frozen peak', () => {
  const prices = [...flat(121), 79, 86, 79, 49, 70, 49];
  const result = analyze(prices);
  assert.equal(result.key, 'drawdown50');
  assert.equal(result.cycle.peak, 100);
  assert.equal(result.cycle.stages.length, 4);
  assert.equal(new Set(result.stageSignals.map((s) => s.id)).size, 4);
  assert.deepEqual(result.newStages, []);
  assert.deepEqual(analyze(prices), result);
});

test('short recovery outranks oversold only after five above-MA20 closes and retains stages', () => {
  const base = [...flat(121), ...flat(30, 49)];
  assert.equal(analyze([...base, 50,51,52,53]).key, 'drawdown50');
  const result = analyze([...base, 50,51,52,53,54]);
  assert.equal(result.key, 'recovery');
  assert.equal(result.cash, 0);
  assert.equal(result.cycle.declining, true);
  assert.equal(result.cycle.peak, 100);
  assert.equal(result.cycle.stages.length, 4);
  assert.equal(result.cycleReset, false);
});

test('new cycle needs ten above-MA120 closes since decline and a rising ten-day MA60', () => {
  const prices = [...flat(121), ...flat(130, 50), ...Array.from({length: 50}, (_, i) => 51 + i)];
  let resetIndex = -1;
  for (let i = 252; i < prices.length; i++) {
    const result = analyze(prices.slice(0, i + 1));
    if (result.cycleReset) { resetIndex = i; break; }
  }
  assert.ok(resetIndex > 0);
  const before = analyze(prices.slice(0, resetIndex));
  const after = analyze(prices.slice(0, resetIndex + 1));
  assert.equal(before.cycle.declining, true);
  assert.equal(before.cycle.stages.length, 4);
  assert.equal(after.cycle.declining, false);
  assert.equal(after.cycle.stages.length, 0);
  assert.equal(after.cycle.id, after.asOf);
  assert.equal(after.metrics.rising60Ten, true);
  assert.ok(after.metrics.above120 >= 10);
  assert.ok(before.cycle.above120 < 10 || !before.metrics.rising60Ten);
  assert.ok(after.cycle.peak < 100);
  const secondDecline = analyze([...prices.slice(0, resetIndex + 1), 1]);
  assert.equal(secondDecline.cycle.stages.length, 4);
  assert.equal(secondDecline.stageSignals.length, 8);
  assert.equal(new Set(secondDecline.stageSignals.map((s) => s.id)).size, 8);
});

test('transition date changes on actual regime change, not every refreshed day', () => {
  const before = analyze([...flat(121), 99,98]);
  const after = analyze([...flat(121), 99,98,97]);
  assert.equal(after.key, 'decline1');
  assert.equal(after.transitionDate, before.transitionDate);
  const next = analyze([...flat(121),99,98,97,80]);
  assert.notEqual(next.transitionDate, before.transitionDate);
});

test('only completed daily sessions are eligible, independently in Korea and US (DST aware)', () => {
  const rows = [{date:'2026-10-16',close:100},{date:'2026-10-19',close:101}];
  assert.equal(engine.confirmedRows(rows,'KOSPI','2026-10-19T06:39:00Z').length,1);
  assert.equal(engine.confirmedRows(rows,'KOSPI','2026-10-19T06:40:00Z').length,2);
  assert.equal(engine.confirmedRows(rows,'NASDAQ','2026-10-19T20:09:00Z').length,1);
  assert.equal(engine.confirmedRows(rows,'NASDAQ','2026-10-19T20:10:00Z').length,2);
  const winter = [{date:'2026-12-18',close:100}];
  assert.equal(engine.confirmedRows(winter,'SP500','2026-12-18T21:09:00Z').length,0);
  assert.equal(engine.confirmedRows(winter,'SP500','2026-12-18T21:10:00Z').length,1);
  assert.equal(engine.confirmedRows([{...rows[0], confirmed:false}],'KOSPI',NOW).length,0);
  assert.equal(engine.confirmedRows([{date:'2026-10-17',close:1}],'KOSPI',NOW).length,0);
  assert.equal(engine.confirmedRows([{date:'2026-10-20',close:1}],'KOSPI',NOW).length,0);
});

test('history persistence is isolated per index and preserves stages as source windows roll', () => {
  const store = storage();
  const all = bars([...flat(121),79,85,79]);
  const first = view.evaluate(all.slice(0,-1),'KOSPI',store,NOW);
  const second = view.evaluate(all.slice(-20),'KOSPI',store,NOW);
  assert.equal(second.result.cycle.stages.length,1);
  assert.equal(second.result.historyCount,all.length);
  assert.equal(second.result.cycle.id,first.result.cycle.id);
  const other = view.evaluate(bars(Array.from({length:150},(_,i)=>100+i)), 'NASDAQ',store,NOW);
  assert.equal(other.result.key,'superBull');
  assert.equal(second.result.key,'drawdown20');
  assert.equal(store.values.size,2);
  assert.throws(()=>view.evaluate([], 'KOSPI', store, NOW), /원천/);
});

test('source restatements win over saved rows and storage failure never crashes analysis', () => {
  const store = storage();
  const initial = bars([...flat(121),79]);
  view.evaluate(initial,'KOSPI',store,NOW);
  const corrected = initial.map((r)=>({...r,close:100,high:100,low:100}));
  assert.equal(view.evaluate(corrected,'KOSPI',store,NOW).result.key,'sideways');
  const blocked = {getItem(){throw new Error('blocked');},setItem(){throw new Error('readonly');}};
  const result = view.evaluate(initial,'KOSPI',blocked,NOW);
  assert.equal(result.result.key,'drawdown20');
  assert.equal(result.persistent,false);
});

test('header renders sorted MA position and colored direction beside all target metrics', () => {
  const rows = bars(Array.from({length:150},(_,i)=>100+i+0.49));
  const result = engine.analyze(rows,'KOSPI',{now:NOW});
  const html = view.render(result,{rows,persistent:true});
  assert.match(html,/regime-arrow up[^>]*[^]*?↗/);
  assert.match(html,/목표 현금/);
  assert.match(html,/목표 신용/);
  assert.match(html,/주식 노출률/);
  assert.match(html,/기준 고점/);
  assert.match(html,/최근 국면 전환/);
  assert.match(html,/실제 계좌 비중과 다를 수 있습니다/);
  assert.doesNotMatch(html,/높은 가격순|확정 일봉|조건·이력|<details/);
  assert.doesNotMatch(html,/249\.49/);
  assert.equal(result.close,249.49);
  assert.ok(html.indexOf('현재가') < html.indexOf('20일</span>'));
  assert.ok(html.indexOf('20일</span>') < html.indexOf('60일</span>'));
  assert.ok(html.indexOf('60일</span>') < html.indexOf('120일</span>'));
  for(const color of Object.values(view.MA_COLORS)) assert.ok(html.includes(color));
  const pending = view.render(engine.analyze([],'KOSPI',{now:NOW}));
  assert.match(pending,/목표 현금 <b>-<\/b>/);
  assert.doesNotMatch(pending,/目標|確定/);
});

test('reference peak uses closing prices rather than intraday highs', () => {
  const rows = bars([...flat(121),80]);
  rows[100].high = 1000;
  const result = engine.analyze(rows,'KOSPI',{now:NOW});
  assert.equal(result.cycle.peak,100);
  assert.equal(result.key,'drawdown20');
});

test('a pullback above rising MA20 does not freeze the reference peak prematurely', () => {
  const result = analyze([...flat(121),1000,900,1100]);
  assert.equal(result.cycle.peak,1100);
  assert.equal(result.cycle.declining,false);
  assert.equal(result.drawdown,0);
});

test('a late failed daily request cannot replace a newer valid allocation', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const node = {innerHTML:''};
  let rejectRequest, requests = 0;
  const response = new Promise((_,reject)=>{rejectRequest=reject;});
  const context = vm.createContext({MarketRegime:engine, Date,
    document:{getElementById:()=>node},localStorage:storage(),
    fetch:()=>{requests++;return response;}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../market-regime-view.js'),'utf8'),context);
  const inst={key:'KOSPI',options:{maCompare:true}};
  const old = context.MarketRegimeView.update(inst);
  const duplicate = context.MarketRegimeView.update(inst);
  assert.equal(requests,1);
  await context.MarketRegimeView.update(inst,bars(Array.from({length:150},(_,i)=>100+i)));
  const valid = node.innerHTML;
  assert.match(valid,/초강세 상승/);
  rejectRequest(new Error('old request failed'));
  await Promise.all([old,duplicate]);
  assert.equal(node.innerHTML,valid);
  await context.MarketRegimeView.update(inst,[]);
  assert.match(node.innerHTML,/판단보류/);
  assert.match(node.innerHTML,/목표 현금 <b>-<\/b>/);
});

test('index panels follow the candle legend and precede charts without overlaying them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const legend = html.indexOf('id="legend-${item.popupKey}"');
  const panel = html.indexOf('id="market-regime-${item.popupKey}"');
  const chart = html.indexOf('id="lwchart-${item.popupKey}"');
  assert.ok(legend < panel && panel < chart);
  assert.doesNotMatch(html, /\.index-regime-panel \{[^}]*position:absolute/);
  assert.match(html, /\.regime-allocations b \{ font-size:16px/);
  assert.doesNotMatch(html,/function renderMaCompareOverlay/);
});

test('separate index quote keeps whole points and precise percent changes, with missing data as dashes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const parent = {className:'',title:''};
  const price = {textContent:'',parentElement:parent};
  const rate = {textContent:''}, previous = {textContent:''};
  const context = vm.createContext({document:{
    getElementById:(id)=>id==='index-price-KOSPI'?price:id==='index-rate-KOSPI'?rate:null,
    querySelector:()=>previous
  }});
  vm.runInContext(source.slice(source.indexOf('    function updateIndexQuote('),source.indexOf('    function refreshIndexRegime(')),context);
  context.updateIndexQuote('KOSPI',{price:3349.49,previousClose:3348.35,changePercent:0.03,asOf:'2026-10-16'});
  assert.equal(price.textContent,'3,349pt');
  assert.equal(previous.textContent,'3,348\n직전가');
  assert.equal(rate.textContent,'+0.03%');
  assert.equal(parent.className,'index-quote-current up');
  assert.match(parent.title,/2026-10-16/);
  context.updateIndexQuote('KOSPI',null);
  assert.equal(price.textContent,'-pt');
  assert.equal(previous.textContent,'-\n직전가');
  assert.equal(rate.textContent,'-');
});
