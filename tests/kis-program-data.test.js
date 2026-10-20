'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createProgramReader,parseCurrent,parseDaily}=require('../kis-program-data');
const {programNetEok,mergeFlowStats}=require('../flow-stats');
function dailyRows() {
  const rows=[];
  for(let day=new Date('2026-10-20T00:00:00Z');rows.length<20;day.setUTCDate(day.getUTCDate()-1)){
    if([0,6].includes(day.getUTCDay()))continue;
    rows.push({stck_bsop_date:day.toISOString().slice(0,10).replace(/-/g,''),whol_smtn_shnu_tr_pbmn:'20000',whol_onsl_seln_tr_pbmn:'4000',whol_entm_seln_tr_pbmn:'6000'});
  }
  return rows;
}
test('KIS daily money can be derived from its self/entrusted columns, without inferring missing operands as zero',()=>{
  assert.equal(programNetEok(dailyRows()[0]),100);
  assert.equal(programNetEok({arbt_smtm_ntby_tr_pbmn:'200',nabt_smtn_ntby_tr_pbmn:'-300'}),-1);
  assert.equal(programNetEok({arbt_smtn_ntby_tr_pbmn:'',arbt_smtm_ntby_tr_pbmn:'200',nabt_smtn_ntby_tr_pbmn:'-300'}),-1);
  assert.equal(programNetEok({whol_smtn_shnu_tr_pbmn:'20000',whol_onsl_seln_tr_pbmn:'4000'}),null);
  assert.equal(parseDaily({output:{metadata:true},output1:dailyRows()}).length,20);
});
test('KIS after-close time rows remain final values; invalid times and absent amounts are rejected',()=>{
  const rows=parseCurrent({output:[{bsop_hour:'165900',stck_bsop_date:'20261020',whol_smtn_ntby_tr_pbmn:'12300'},
    {bsop_hour:93000,whol_smtn_ntby_tr_pbmn:'0'},{bsop_hour:'150060',whol_smtn_ntby_tr_pbmn:'10'},
    {bsop_hour:'170001',whol_smtn_ntby_tr_pbmn:'10'},{bsop_hour:'151200'},
    {bsop_hour:'151200',stck_bsop_date:'20260230',whol_smtn_ntby_tr_pbmn:'100'}]});
  assert.equal(rows.length,2);assert.equal(rows[0].hour,'093000');assert.equal(rows[0].value,0);
  assert.equal(rows[1].value,123);assert.equal(rows[1].hhmm,'15:30');assert.equal(rows[1].final,true);
});
test('history fallback retries a recent month, and valid live zero replaces today while preserving complete window sums',async()=>{
  let days=0,current=0;const calls=[];
  const reader=createProgramReader({request:async(path,tr,params)=>{
    calls.push({path,tr,params});
    if(tr==='FHPPG04600001')return ++days===1?{rt_cd:'0',output:[]}:{rt_cd:'0',output:dailyRows()};
    current++;return{rt_cd:'0',output:{bsop_hour:'151200',stck_bsop_date:'20261020',whol_smtn_ntby_tr_pbmn:'0'}};
  }});
  const result=await reader.summary('2026-10-20',{date:'2026-10-20',minutes:15*60+12});
  assert.deepEqual(result.values,[0,200,400,900,1900]);assert.equal(result.coverageDays,20);
  assert.equal(result.asOfDate,'2026-10-20');assert.equal(result.diagnostics.current.ok,true);
  const historyCalls=calls.filter(call=>call.tr==='FHPPG04600001');
  assert.equal(historyCalls[0].params.FID_INPUT_DATE_1,'20260622');
  assert.equal(historyCalls[1].params.FID_INPUT_DATE_1,'20260920');
  await reader.summary('2026-10-20',{date:'2026-10-20',minutes:15*60+12});assert.equal(days,2);assert.equal(current,1);
});
test('a time endpoint succeeds independently of failed daily history, including a regular close after 15:35',async()=>{
  const reader=createProgramReader({request:async(path,tr)=>tr==='FHPPG04600001'?{rt_cd:'1',msg_cd:'EGW00121',msg1:'DO_NOT_LEAK_PAYLOAD'}:
    {rt_cd:'0',output:[{bsop_hour:'170000',stck_bsop_date:'20261020',whol_smtn_ntby_tr_pbmn:'12300'}]}});
  const result=await reader.summary('2026-10-20',{date:'2026-10-20',minutes:18*60});
  assert.deepEqual(result.values,[123,null,null,null,null]);assert.equal(result.asOfHour,'170000');assert.match(result.source,/^KIS/);
  assert.equal(result.diagnostics.history.code,'EGW00121');assert.doesNotMatch(JSON.stringify(result),/DO_NOT_LEAK/);
});
test('old undated or future-hour responses cannot be assigned to today; dated previous-session closes remain usable',async()=>{
  const rows=[{bsop_hour:'170000',whol_smtn_ntby_tr_pbmn:'99900'}];
  const reader=createProgramReader({request:async(path,tr)=>({rt_cd:'0',output:tr==='FHPPG04600001'?[]:rows})});
  assert.equal((await reader.summary('2026-10-20',{date:'2026-10-20',minutes:9*60+1})).values,null);
  assert.equal((await reader.summary('2026-10-19',{date:'2026-10-20',minutes:8*60})).values,null);
  const dated=createProgramReader({request:async(path,tr)=>({rt_cd:'0',output:tr==='FHPPG04600001'?[]:[{...rows[0],stck_bsop_date:'20261019'}]})});
  assert.deepEqual((await dated.summary('2026-10-19',{date:'2026-10-20',minutes:8*60})).values,[999,null,null,null,null]);
});
test('KIS failures expose only safe per-endpoint codes and are throttled for twenty seconds',async()=>{
  let calls=0;const reader=createProgramReader({request:async()=>{calls++;return{rt_cd:'1',msg_cd:'EGW00121',msg1:'PRIVATE_HEADERS_AND_KEYS'};}});
  const out=await reader.summary('2026-10-20',{date:'2026-10-20',minutes:900});
  assert.equal(out.values,null);assert.match(out.error,/EGW00121/);assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);
  await reader.summary('2026-10-20',{date:'2026-10-20',minutes:900});assert.equal(calls,2);
});
test('Oracle preference uses a single contract row and rejects public program fallback without mixing units',()=>{
  const core={futuresMode:'spot-fallback',futuresUnit:'억원',futuresArray:[100,200,300,400,500],progsArray:[11,22,33,44,55],programSource:'Naver Finance'};
  const flow={futuresArray:[-3441,null,null,null,null],futuresCoverageDays:1,programSource:'unavailable',programError:'KIS 프로그램 조회 확인: EGW00121',programDiagnostics:{history:{code:'EGW00121'}}};
  const result=mergeFlowStats(core,flow,{preferKis:true});
  assert.equal(result.futuresMode,'futures');assert.equal(result.futuresUnit,'계약');assert.deepEqual(result.futuresArray,[-3441,null,null,null,null]);
  assert.equal(result.progsArray,null);assert.equal(result.programSource,'unavailable');assert.match(result.programError,/EGW00121/);
});
test('Oracle diagnosis command uses injected environment credentials but never prints their values or raw KIS bodies',async()=>{
  const {main}=require('../scripts/check-kis-program');const printed=[];
  const result=await main({env:{KIS_APP_KEY:'TEST_ONLY_PRIVATE_KEY',KIS_APP_SECRET:'TEST_ONLY_PRIVATE_SECRET'},
    now:new Date('2026-10-20T06:12:00Z'),write:value=>printed.push(value),client:{credentials:env=>({appKey:env.KIS_APP_KEY,appSecret:env.KIS_APP_SECRET}),getAccessToken:async()=> 'TEST_ONLY_PRIVATE_TOKEN'},
    fetchImpl:async(url,opts)=>{assert.equal(opts.headers.authorization,'Bearer TEST_ONLY_PRIVATE_TOKEN');return{ok:true,json:async()=>({rt_cd:'0',output:String(url).includes('daily')?dailyRows():[{bsop_hour:'151200',stck_bsop_date:'20261020',whol_smtn_ntby_tr_pbmn:'100'}],private:'DO_NOT_PRINT'})};}});
  assert.equal(result,true);assert.equal(printed[0].configured,true);assert.doesNotMatch(JSON.stringify(printed),/PRIVATE|DO_NOT_PRINT/);
  const missing=await main({env:{},client:{credentials:()=>({})},write:value=>printed.push(value)});
  assert.equal(missing,false);assert.equal(printed.at(-1).configured,false);
});
test('the actual gateway stats route selects its KIS contract/program response even when the core sends spot/public fallback',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const core={ok:true,futuresMode:'spot-fallback',futuresUnit:'억원',futuresArray:[9999,20000,30000,40000,50000],programSource:'Naver Finance',progsArray:[10,20,30,40,50]};
  const flow={latestOpenDate:'2026-10-20',futuresArray:[-3441,null,null,null,null],futuresCoverageDays:1,programSource:'KIS FHPPG04600001/FHPPG04600101',progsArray:[123,null,null,null,null],programCoverageDays:1,programAsOfDate:'2026-10-20'};
  const context=vm.createContext({module:{exports:{}},__dirname:path.join(__dirname,'..'),URL,Buffer,console,setTimeout,clearTimeout,setInterval,process:{env:{},on(){}},core,flow,
    require:id=>id==='path'?path:id==='./flow-stats'?require('../flow-stats'):id==='./access-control'?require('../access-control'):id==='./kis-program-data'?require('../kis-program-data'):id==='fs'?{readFileSync(){throw new Error('Protected file reads forbidden');}}:{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','kis-flow-gateway.js'),'utf8')+`\nfetchCoreJson=async()=>core;buildFlowStats=async()=>flow;hasKisCredentials=()=>true;module.exports.handleRequest=handleRequest;`,context);
  let result;
  await context.module.exports.handleRequest({url:'/stock3-7/api/stats',headers:{host:'localhost','x-stock3-password':'1222'}},{writeHead(){},end(body){result=JSON.parse(body);}});
  assert.equal(result.futuresMode,'futures');assert.equal(result.futuresUnit,'계약');
  assert.deepEqual(result.futuresArray,[-3441,null,null,null,null]);assert.deepEqual(result.progsArray,[123,null,null,null,null]);
  assert.match(result.programSource,/^KIS/);assert.equal(result.kisConfigured,true);
});
