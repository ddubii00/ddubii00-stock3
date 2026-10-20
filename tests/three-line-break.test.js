'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lb = require('../three-line-break');
const regime = require('../market-regime');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rows = (prices) => prices.map((close, i) => ({time:`2025-01-${String(i + 1).padStart(2,'0')}`,close}));

test('line break extends a trend and reverses only below the last three formed lines', () => {
  const actual = lb.build(rows([100,110,120,130,125,115,100,99,98,105,131]));
  assert.deepEqual(actual.map(r=>[r.open,r.close]),[[100,110],[110,120],[120,130],[120,99],[99,98],[99,131]]);
  assert.equal(actual[3].time, '2025-01-08');
  assert.ok(actual.every(r=>r.high===Math.max(r.open,r.close)&&r.low===Math.min(r.open,r.close)));
});
test('downward starts, equal boundaries and flat sessions do not create false lines', () => {
  assert.deepEqual(lb.build(rows([100,90,80,70,100,101])).map(r=>[r.open,r.close]),[[100,90],[90,80],[80,70],[80,101]]);
  assert.deepEqual(lb.build(rows([100,100,100])),[]);
  assert.deepEqual(lb.build([]),[]);
  assert.deepEqual(lb.build(null),[]);
});
test('reversal uses three formed lines even across many sessions without a new line', () => {
  const input=rows([100,110,120,130,125,124,123,122,121,115,99]);
  const result=lb.build(input);
  assert.equal(result.length,4);
  assert.equal(result.at(-1).close,99);
  assert.equal(result.at(-1).time,'2025-01-11');
});
test('line break sanitizes dates/prices, sorts, deduplicates and leaves input unchanged', () => {
  const input=[{date:'2025-01-03',close:120},{date:'bad',close:150},{date:'2025-02-30',close:160},
    {date:'2025-01-02',close:105},{date:'2025-01-01',close:100},{date:'2025-01-02',close:110},
    {date:'2025-01-04',close:null},{date:'2025-01-05',close:-1},{date:'2025-01-06',close:Infinity}];
  const before=structuredClone(input);
  assert.deepEqual(lb.build(input).map(r=>r.close),[110,120]);
  assert.deepEqual(input,before);
});
test('daily indicators retain values and only sample formed-line dates', () => {
  const input=rows([100,110,105,120]);
  const indicator=input.map(r=>({time:r.time,value:r.close/2}));
  assert.deepEqual(lb.project(indicator,lb.build(input)),[indicator[1],indicator[3]]);
  assert.equal(indicator.length,4);
});

function dailyPrices(flat=false) {
  const result=[];
  for (let d=new Date('2025-01-01T00:00:00Z');result.length<220;d.setUTCDate(d.getUTCDate()+1)) {
    if ([0,6].includes(d.getUTCDay())) continue;
    const i=result.length;
    result.push({date:d.toISOString().slice(0,10),close:flat?100:100+Math.floor(i/10)+(i%2)*.5});
  }
  return result;
}
function loaderHarness({key='KOSPI', mode='3lb', lineBreakInterval, now='2026-10-20T06:31:00Z', input=dailyPrices(), failFirst=false, macdBackground=false}={}) {
  const elements=new Map(),fills=[];
  const ctx={clearRect(){},fillRect(){fills.push(this.fillStyle);},beginPath(){},setLineDash(){},moveTo(){},lineTo(){},stroke(){}};
  const target={clientWidth:600,clientHeight:270,dataset:{},style:{},setAttribute(k,v){this[k]=v;},querySelector(s){return elements.get(s)||null;},appendChild(el){elements.set('.'+el.className,el);}};
  const series=()=>({data:[],setData(data){this.data=data;},setMarkers(data){this.markers=data;}});
  const scale={setVisibleRange(){},fitContent(){},getVisibleLogicalRange:()=>({from:0,to:input.length-1}),logicalToCoordinate:i=>i*2,unsubscribeVisibleLogicalRangeChange(){},unsubscribeSizeChange(){},subscribeVisibleLogicalRangeChange(){},subscribeSizeChange(){}};
  const applied=[];
  const inst={key,interval:mode,lineBreakInterval,containerId:'chart',visibleCount:120,options:{plain:true,noMarkers:true,macdBackground},
    candleSeries:series(),maSeries:Object.fromEntries([5,10,20,60,120,200].map(p=>[p,series()])),
    bbSeries:{upper:series(),lower:series()},chart:{applyOptions(options){applied.push(options);},subscribeCrosshairMove(){},timeScale(){return scale;}}};
  const calls=[],refreshes=[];
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return Date.parse(now);} }
  const context=vm.createContext({window:{ThreeLineBreak:lb,MarketRegime:regime},lwChartInstances:{[key]:inst},
    Date:FixedDate,
    document:{getElementById(){return target;},createElement(){return{style:{},getContext:()=>ctx,remove(){elements.delete('.'+this.className);}};}},
    apiUrl:x=>x,fetch:async url=>{calls.push(url);return{json:async()=>failFirst?{ok:false}:{ok:true,series:input}};},
    fetchJsonWithRetry:async url=>{calls.push(url);return{ok:true,series:input};},
    refreshIndexRegime:(instance,data)=>refreshes.push(data),console:{error(){}}});
  const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end));
  vm.runInContext([
    extract('    function calculateSMA(', '    function latestSmaValue('),
    extract('    function calculateBollinger(', '    function calculateEMA('),
    extract('    function calculateEMA(', '    function buildMinuteWindow('),
    extract('    async function loadLwChart(', '    function initLwChart(')
  ].join('\n'),context);
  return {inst,target,calls,refreshes,fills,applied,run:()=>context.loadLwChart(key)};
}

test('index three-line mode retains the selected minute interval and falls back to daily for non-minute views',()=>{
  const context=vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('    function setIndexTimeframe('),html.indexOf('    async function loadLwChart(')),context);
  for(const interval of ['1m','3m','5m','60m']){
    const inst={interval};context.setIndexTimeframe(inst,'3lb',1);
    assert.equal(inst.interval,'3lb');assert.equal(inst.lineBreakInterval,interval);
    context.setIndexTimeframe(inst,'3lb',1);assert.equal(inst.lineBreakInterval,interval);
    context.setIndexTimeframe(inst,'1d',1);assert.equal(inst.interval,'1d');
  }
  const inst={interval:'1wk'};context.setIndexTimeframe(inst,'3lb',1);assert.equal(inst.lineBreakInterval,'1d');
});

test('one-minute index line breaks use intraday timestamps and form many lines during one session',async()=>{
  const start=Date.parse('2026-10-20T09:00:00Z')/1000;
  const input=Array.from({length:180},(_,i)=>({date:start+i*60,close:3000+i}));
  for(const key of ['KOSPI','KOSDAQ'])for(const failFirst of [false,true]){
    const h=loaderHarness({key,input,lineBreakInterval:'1m',failFirst});await h.run();
    assert.ok(h.calls.every(url=>url.endsWith('interval=1m')));
    assert.equal(h.inst.candleSeries.data.length,179);
    assert.equal(h.inst.candleSeries.data.at(-1).time,start+179*60);
    assert.equal(h.refreshes[0],undefined); // Regime panel must fetch its own daily source.
    assert.equal(h.target.dataset.sourceInterval,'1m');
    if(!failFirst)assert.ok(h.applied.some(options=>options.timeScale?.timeVisible===true));
  }
});

test('minute line break ignores an unfinished source candle but accepts the 15:30 final close after 15:31',async()=>{
  const stamp=time=>Date.parse(`2026-10-20T${time}:00Z`)/1000;
  const h=loaderHarness({lineBreakInterval:'5m',now:'2026-10-20T06:31:00Z',input:[
    {date:stamp('15:10'),close:100},{date:stamp('15:15'),close:110},
    {date:stamp('15:30'),close:120},{date:stamp('15:35'),close:999}
  ]});await h.run();
  assert.deepEqual(h.inst.candleSeries.data.map(row=>row.close),[110,120]);
  const current=loaderHarness({lineBreakInterval:'5m',now:'2026-10-20T00:07:00Z',input:[
    {date:stamp('09:00'),close:100},{date:stamp('09:05'),close:999}
  ]});await current.run();assert.equal(current.inst.candleSeries.data.length,0);
});
test('all six line-break charts fetch daily input and keep daily regime/MA/BB values', async()=>{
  for (const key of ['KOSPI','KOSDAQ','NASDAQ','SP500','KR:005930:KOSPI','KR:000660:KOSPI']) {
    const h=loaderHarness({key});await h.run();
    assert.equal(h.calls.length,1);
    assert.match(h.calls[0],/interval=1d$/);
    assert.equal(h.target.dataset.chartType,'line-break');
    assert.ok(h.inst.candleSeries.data.length<dailyPrices().length);
    const times=new Set(h.inst.candleSeries.data.map(r=>r.time));
    assert.ok(h.inst.maSeries[20].data.every(r=>times.has(r.time)));
    assert.ok(h.inst.bbSeries.upper.data.every(r=>times.has(r.time)));
    assert.equal(h.inst.smaDataMap[20].length,201);
    assert.equal(h.refreshes[0].length,220);
    const last=h.inst.maSeries[20].data.at(-1);
    const raw=dailyPrices();const index=raw.findIndex(r=>r.date===last.time);
    const expected=raw.slice(index-19,index+1).reduce((n,r)=>n+r.close,0)/20;
    assert.equal(last.value,expected);
    assert.equal(h.inst.candleSeries.markers.length,0);
  }
});
test('line-break fallback requests daily data and applies the same transform and indicators',async()=>{
  const h=loaderHarness({failFirst:true});await h.run();
  assert.equal(h.calls.length,2);
  assert.ok(h.calls.every(url=>url.endsWith('interval=1d')));
  assert.deepEqual(JSON.parse(JSON.stringify(h.inst.candleSeries.data)),lb.build(regime.confirmedRows(dailyPrices(),'KOSPI')));
  assert.equal(h.inst.smaDataMap[20].length,201);
  assert.equal(h.refreshes[0].length,220);
});
test('flat closing prices show an empty line-break state without inventing candles',async()=>{
  const h=loaderHarness({input:dailyPrices(true)});await h.run();
  assert.equal(h.calls.length,1);
  assert.equal(h.inst.candleSeries.data.length,0);
  assert.equal(h.target.querySelector('.chart-load-warning').textContent,'삼선전환 생성 조건을 기다리는 중');
  assert.equal(h.refreshes[0].length,220);
});
test('unconfirmed and future sessions cannot form lines, while ordinary candles still retain OHLC',async()=>{
  const input=[...dailyPrices(),{date:'2099-01-01',close:999},{date:'2026-10-16',close:500,isFinal:false}];
  const lbChart=loaderHarness({input});await lbChart.run();
  assert.ok(lbChart.inst.candleSeries.data.every(r=>r.close<500));
  const candle=loaderHarness({input:dailyPrices(),mode:'1wk'});await candle.run();
  assert.match(candle.calls[0],/interval=1wk$/);
  assert.equal(candle.inst.candleSeries.data.length,220);
  assert.equal(candle.target.dataset.chartType,'candlestick');
});

test('registered stock candles use MACD zero-line backgrounds independently of the plain chart option',async()=>{
  for(const [name,input,color] of [['KR:005930:KOSPI',dailyPrices(),'rgba(255, 80, 80, 0.18)'],['US:AAPL:NASDAQ',dailyPrices().map((row,i)=>({...row,close:400-i})),'rgba(60, 120, 255, 0.15)']]){
    const h=loaderHarness({key:name,mode:'1d',input,macdBackground:true});await h.run();
    assert.ok(h.target.querySelector('.bg-canvas'));assert.ok(h.fills.includes(color));assert.ok(h.inst.candleSeries.data.length);
  }
});
