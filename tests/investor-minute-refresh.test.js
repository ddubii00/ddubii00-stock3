'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),date='2026-10-21';
const values={foreign:0.1,institution:-0.2,individual:0.1};
function fixture({snapshot=async()=>values,now='2026-10-21T01:01:00Z'}={}){
  let clock=Date.parse(now),writes=0;
  const calls=[];
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const context=vm.createContext({module:{exports:{}},__dirname:root,Date:FixedDate,URL,Buffer,setTimeout,clearTimeout,setInterval,console,
    process:{env:{KIS_APP_KEY:'TEST_ONLY_KEY',KIS_APP_SECRET:'TEST_ONLY_SECRET'},on(){}},
    require:id=>id==='path'?path:id==='./flow-stats'?require('../flow-stats'):id==='./access-control'?require('../access-control'):id==='fs'?{readFileSync(){throw new Error('Protected store reads forbidden');}}:{},
    fixtureSnapshot:async kind=>{calls.push(kind);return snapshot(kind);}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'kis-flow-gateway.js'),'utf8')+`
    store.loaded=true;store.days={'${date}':{KOSPI:[{date:'${date} 09:59',foreign:0.01,institution:-0.02,individual:0.01}],KOSDAQ:[{date:'${date} 09:59',foreign:0.01,institution:-0.02,individual:0.01}]}};
    getLatestOpenDate=async()=> '${date}';backfillIntradayRows=async()=>{};
    fetchInvestorSnapshot=fixtureSnapshot;persistStore=()=>fixturePersist();
    state.pollRunning=true; // A slow unrelated collector must not block either chart.
    module.exports.build=buildInvestorChart;module.exports.refresh=refreshInvestorMarket;module.exports.status=()=>state.investorRefresh;
  `,Object.assign(context,{fixturePersist:()=>{writes++;}}));
  return {api:context.module.exports,calls,writes:()=>writes,setClock:value=>{clock=Date.parse(value);}};
}

test('KOSPI and KOSDAQ update past 09:59 even while the combined collector is busy',async()=>{
  const f=fixture();
  const results=await Promise.all(['KOSPI','KOSDAQ'].map(kind=>f.api.build(kind)));
  assert.deepEqual(f.calls.sort(),['KOSDAQ','KOSPI']);assert.equal(f.writes(),2);
  for(const payload of results){
    assert.equal(payload.series.at(-1).date,`${date} 10:01`);assert.equal(payload.lastDataAt,`${date} 10:01`);
    assert.equal(payload.stale,false);assert.equal(payload.refreshError,'');assert.match(payload.note,/마지막 수집.*10:01/);
  }
  f.setClock('2026-10-21T02:03:00Z');
  assert.equal((await f.api.build('KOSPI')).lastDataAt,`${date} 11:03`);
});

test('concurrent visitors await one per-market request and reuse it within twenty seconds',async()=>{
  let finish;
  const f=fixture({snapshot:()=>new Promise(resolve=>{finish=resolve;})});
  const a=f.api.build('KOSPI'),b=f.api.build('KOSPI');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
  finish(values);
  const result=await Promise.all([a,b]);
  assert.ok(result.every(payload=>payload.lastDataAt===`${date} 10:01`));
  f.setClock('2026-10-21T01:01:10Z');await f.api.build('KOSPI');assert.equal(f.calls.length,1);
});

test('source failures retain the real curve, expose a safe error and recover without restarting',async()=>{
  let fail=true;
  const f=fixture({now:'2026-10-21T01:10:00Z',snapshot:async()=>{if(fail)throw Object.assign(new Error('DO_NOT_PRINT_PRIVATE_BODY'),{kisCode:'EGW00201'});return values;}});
  const stalled=await f.api.build('KOSPI');
  assert.equal(stalled.lastDataAt,`${date} 09:59`);assert.equal(stalled.series.length,1);assert.equal(stalled.stale,true);
  assert.equal(stalled.refreshError,'EGW00201');assert.match(stalled.note,/갱신 지연/);assert.doesNotMatch(JSON.stringify(stalled),/PRIVATE|TEST_ONLY/);
  fail=false;f.setClock('2026-10-21T01:10:21Z');
  const recovered=await f.api.build('KOSPI');
  assert.equal(recovered.lastDataAt,`${date} 10:10`);assert.equal(recovered.refreshError,'');assert.equal(recovered.stale,false);
});

test('one market failure does not hold back the other market and an overnight reply cannot create a new session',async()=>{
  const f=fixture({snapshot:async kind=>{if(kind==='KOSPI')throw new Error('offline');return values;}});
  const [kospi,kosdaq]=await Promise.all([f.api.build('KOSPI'),f.api.build('KOSDAQ')]);
  assert.equal(kospi.lastDataAt,`${date} 09:59`);assert.equal(kosdaq.lastDataAt,`${date} 10:01`);
  let finish;
  const closing=fixture({now:'2026-10-21T06:30:00Z',snapshot:()=>new Promise(resolve=>{finish=resolve;})});
  const request=closing.api.build('KOSPI');await new Promise(resolve=>setImmediate(resolve));
  closing.setClock('2026-10-22T00:00:00Z');finish(values);
  assert.equal((await request).lastDataAt,`${date} 09:59`);
});

test('missing snapshot quantities or money are never recorded as zero',()=>{
  const {parseInvestorSnapshot}=require('../kis-flow-gateway');
  assert.throws(()=>parseInvestorSnapshot({output:[{frgn_ntby_tr_pbmn:null,orgn_ntby_tr_pbmn:'',prsn_ntby_tr_pbmn:undefined}]},'KOSPI'));
  assert.deepEqual(parseInvestorSnapshot({output:[{frgn_ntby_tr_pbmn:'0',orgn_ntby_tr_pbmn:'0',prsn_ntby_tr_pbmn:'0'}]},'KOSPI'),{foreign:0,institution:0,individual:0});
});

test('an older browser response cannot overwrite a newer investor minute chart',async()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const nodes={chart:{clientWidth:600,clientHeight:270,innerHTML:'',querySelector:()=>null},note:{textContent:''}},pending=[];
  const context=vm.createContext({document:{getElementById:id=>nodes[id]},URLSearchParams,fetchJsonWithRetry:()=>new Promise(resolve=>pending.push(resolve))});
  vm.runInContext(html.slice(html.indexOf('    async function renderExtraChart('),html.indexOf('    function bindInvestorDaysInput(')),context);
  const render=()=>context.renderExtraChart('chart','note','kospi-investor-minute',[{key:'foreign',label:'외국인',color:'red'}],{showLastValues:true});
  const old=render(),latest=render();
  pending[1]({ok:true,unit:'조원',note:'새 자료',series:[{date:`${date} 10:03`,foreign:0.2}]});await latest;
  pending[0]({ok:true,unit:'조원',note:'이전 자료',series:[{date:`${date} 09:59`,foreign:0.1}]});await old;
  assert.match(nodes.chart.innerHTML,/10:03/);assert.doesNotMatch(nodes.chart.innerHTML,/09:59/);assert.equal(nodes.note.textContent,'새 자료');
});
