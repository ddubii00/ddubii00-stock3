'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {mergeFlowStats}=require('../flow-stats'),root=path.join(__dirname,'..');
async function fixture(payload,days,status=200){
  const context=vm.createContext({module:{exports:{}},__dirname:root,Buffer,process:{env:{},on(){}},fixturePayload:payload,fixtureStatus:status,
    require:id=>id==='path'?path:id==='fs'?{readFileSync:()=>JSON.stringify({days})}:{}});
  vm.runInContext(fs.readFileSync(path.join(root,'kis-flow-display.js'),'utf8')+`
    internalRequest=async()=>({statusCode:fixtureStatus,body:Buffer.from(JSON.stringify(fixturePayload))});
    module.exports.handle=handleChartRequest;
  `,context);
  return {latest:context.module.exports.findLatestStoredCurve,handle:async(kind='KOSPI')=>{
    let result;
    await context.module.exports.handle({}, {writeHead(){},end:body=>{result=JSON.parse(body);}}, {unit:kind==='FUTURES'?'계약':'조원',storeKind:kind,label:kind});
    return result;
  }};
}
const point=(date,time,extra={})=>({date:`${date} ${time}`,foreign:1,institution:-1,individual:0,...extra});
const friday='2026-10-23',monday='2026-10-26';
test('missing Monday data never becomes Friday even when Friday has a complete saved curve',async()=>{
  const f=await fixture({ok:true,unit:'조원',latestOpenDate:monday,series:[]},{[friday]:{KOSPI:Array.from({length:30},(_,i)=>point(friday,`10:${String(i).padStart(2,'0')}`))}});
  const result=await f.handle();assert.equal(result.latestOpenDate,monday);assert.deepEqual(result.series,[]);assert.match(result.note,/이전 날짜 자료로 바꾸지 않고/);
});
test('one current-session observation wins over a longer historical curve, for spot and futures',async()=>{
  for(const kind of ['KOSPI','KOSDAQ','FUTURES']){
    const unit=kind==='FUTURES'?'계약':'조원';
    const f=await fixture({ok:true,unit,latestOpenDate:monday,series:[]},{[friday]:{[kind]:Array.from({length:30},()=>point(friday,'10:00'))},[monday]:{[kind]:[point(monday,'09:01')]}});
    assert.equal(f.latest(kind,monday).date,monday);
    const result=await f.handle(kind);assert.equal(result.displayDate,monday);assert.equal(result.series.length,1);
  }
});
test('a Saturday response reuses the last confirmed session including a single final observation',async()=>{
  const f=await fixture({ok:true,unit:'억원',latestOpenDate:friday,series:[]},{});
  // Existing source/unit mismatch protection remains independent of date selection.
  assert.equal((await f.handle('FUTURES')).unit,'억원');
  const closed=await fixture({ok:true,unit:'계약',latestOpenDate:friday,series:[]},{[friday]:{FUTURES:[point(friday,'15:45',{final:true,fallback:'KIS daily final'})]}});
  assert.equal((await closed.handle('FUTURES')).series[0].date,`${friday} 15:45`);
});
test('a source error or unconfirmed trading date cannot be hidden by historical saved data',async()=>{
  for(const payload of [{ok:false,error:'source error',latestOpenDate:monday,series:[]},{ok:true,series:[]}]){
    const f=await fixture(payload,{[friday]:{KOSPI:[point(friday,'15:30')]}});
    assert.deepEqual((await f.handle()).series,[]);
  }
});
test('stats cannot fill today with futures or program windows from an older core session',()=>{
  const old={latestOpenDate:friday,futuresUnit:'계약',futuresArray:[1,2,3,4,5],futuresLatest:{value:1,asOf:friday},programAsOfDate:friday,programSource:'KIS',progsArray:[1,2,3,4,5]};
  const result=mergeFlowStats(old,{latestOpenDate:monday,futuresArray:null,programSource:'unavailable'},{preferKis:true});
  assert.equal(result.futuresArray,null);assert.equal(result.progsArray,null);assert.equal(result.futuresLatest.asOf,friday);
});
