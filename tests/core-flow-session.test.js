'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const date='2026-10-23',values={foreign:0.1,institution:-0.2,individual:0.1};
function coreFixture(){
  let clock={date,minutes:9*60},writes=0,calls=0;
  const store={days:{}};
  const context=vm.createContext({investorIntradayStore:store,getKoreaClock:()=>clock,loadInvestorIntradayStore(){},persistInvestorIntradayStore(){writes++;},
    getLatestMarketOpenDate:async()=>date,investorRowsFor:(kind,day)=>store.days[day]?.[kind]||[],
    fetchKisInvestorSnapshot:async()=>{calls++;return values;},fetchDaumInvestorDays:async()=>[{date,...values}]});
  for(const [start,end] of [['function recordInvestorSnapshot(','\nasync function captureKisInvestorSnapshots('],['function appendFinalInvestorRow(','\nasync function fetchInvestorSeries('],['async function fetchForeignFuturesMinuteSeries(','\nlet kisProgramReader;']]){
    vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context);
  }
  return {api:context,setClock:(minutes,day=date)=>{clock={date:day,minutes};},writes:()=>writes,calls:()=>calls};
}
test('core never appends a future closing observation during today’s session and persists the real close afterward',async()=>{
  const f=coreFixture();const live=await f.api.fetchKisInvestorTimeRows('KOSPI');
  assert.equal(live.series.at(-1).date,`${date} 09:00`);assert.equal(live.series.some(row=>row.final),false);
  f.setClock(15*60+31);const closed=await f.api.fetchKisInvestorTimeRows('KOSPI');
  assert.equal(closed.series.at(-1).date,`${date} 15:30`);assert.equal(closed.series.at(-1).final,true);assert.ok(f.writes()>=2);
});
test('core futures include the late trading window and retain Friday’s 15:45 final on Saturday',async()=>{
  const f=coreFixture();f.setClock(8*60+45);assert.equal((await f.api.fetchForeignFuturesMinuteSeries()).series.at(-1).date,`${date} 08:45`);
  f.setClock(15*60+44);assert.equal((await f.api.fetchForeignFuturesMinuteSeries()).series.at(-1).date,`${date} 15:44`);
  f.setClock(15*60+47);assert.equal((await f.api.fetchForeignFuturesMinuteSeries()).series.at(-1).date,`${date} 15:45`);
  const calls=f.calls();f.setClock(10*60,'2026-10-24');const weekend=await f.api.fetchForeignFuturesMinuteSeries();
  assert.equal(weekend.latestOpenDate,date);assert.equal(weekend.series.at(-1).date,`${date} 15:45`);assert.equal(f.calls(),calls);
});
test('both core and gateway wire the same today-anchored session reader without waiting for public daily data',async()=>{
  for(const file of ['server.js','kis-flow-gateway.js']){
    const text=fs.readFileSync(path.join(root,file),'utf8'),calls=[];
    const context=vm.createContext({URL,require:id=>{assert.equal(id,'./kis-session-date');return require('../kis-session-date');},
      getKoreaClock:()=>({date:'2026-10-26',minutes:10*60}),state:{},fetchKisAccessToken:async()=> 'TEST_ONLY_TOKEN',kisBaseUrl:()=> 'https://example.invalid',kisHeaders:()=>({}),
      fetchWithTimeout:async url=>{calls.push(url.searchParams.get('BASS_DT'));return{ok:true,json:async()=>({rt_cd:'0',output:[{bass_dt:'20261026',opnd_yn:'Y'}]})};},
      kisGet:async(_path,_tr,params)=>{calls.push(params.BASS_DT);return{output:[{bass_dt:'20261026',opnd_yn:'Y'}]};},
      fetchDaumInvestorDays:async()=>{throw new Error('Public daily rows should not be needed');}});
    const core=file==='server.js',start=core?'async function getLatestMarketOpenDate()':'let sessionDateReader;',end=core?'\nfunction kisPbmnToTrillion':'\nconst INVESTOR_MARKETS';
    vm.runInContext((core?'let kisSessionDateReader;\n':'')+text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start))),context);
    assert.equal(await context[core?'getLatestMarketOpenDate':'getLatestOpenDate'](),'2026-10-26');assert.deepEqual(calls,['20261026']);
  }
});
