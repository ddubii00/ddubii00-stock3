'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const kis=require('../kis-market-data'),minutes=require('../kis-index-minutes');
const ENV={KIS_APP_KEY:'TEST_ONLY_APP_KEY',KIS_APP_SECRET:'TEST_ONLY_APP_SECRET'};
const DAY='20261023',ISO='2026-10-23';
const stamp=time=>Date.parse(`${ISO}T${time}:00Z`)/1000;
const clock=time=>Date.parse(`${ISO}T${time}:00+09:00`);
const bar=(time,close=3300,day=DAY)=>({stck_bsop_date:day,stck_cntg_hour:time.replace(':','')+'00',bstp_nmix_oprc:String(close-1),bstp_nmix_hgpr:String(close+2),bstp_nmix_lwpr:String(close-2),bstp_nmix_prpr:String(close),cntg_vol:'10'});
const ok=(body,continuation='')=>({ok:true,headers:{get:key=>key==='tr_cont'?continuation:null},json:async()=>body});
function fixture(load,initial='10:03'){
  let time=clock(initial),tokens=0;const calls=[];
  const client=kis.createClient({env:ENV,now:()=>time,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/oauth2/tokenP')){tokens++;return ok({access_token:'TEST_ONLY_TOKEN',expires_in:86400});}
    const call={url:new URL(url),headers:options.headers};calls.push(call);return load(call,calls.length);
  }});
  return{client,calls,tokens:()=>tokens,setClock:next=>{time=next;}};
}

test('KOSPI/KOSDAQ minute intervals share one authenticated 1-minute request per market and no scaling',async()=>{
  const f=fixture(call=>ok({rt_cd:'0',output2:[bar('10:02',3349.12),bar('10:01',3348.56)]}));
  const [one,three,five,kosdaq]=await Promise.all([
    f.client.series('KOSPI','1m'),f.client.series('^KS11','3m'),f.client.series('KOSPI','5m'),f.client.series('KOSDAQ','1m')
  ]);
  assert.equal(f.tokens(),1);assert.equal(f.calls.length,2);assert.equal(one.at(-1).close,3349.12);
  assert.equal(one.at(-1).date,stamp('10:02'));assert.equal(kosdaq.at(-1).source,'KIS');
  assert.equal(three.at(-1).sourceTime,stamp('10:02'));assert.equal(five.at(-1).volume,20);
  for(const call of f.calls){
    assert.equal(call.url.pathname,'/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice');
    assert.equal(call.headers.tr_id,'FHKUP03500200');
    assert.equal(call.url.searchParams.get('FID_INPUT_HOUR_1'),'60');
    assert.equal(call.url.searchParams.get('FID_COND_MRKT_DIV_CODE'),'U');
    assert.equal(call.url.searchParams.get('FID_PW_DATA_INCU_YN'),'Y');
  }
  assert.deepEqual(f.calls.map(call=>call.url.searchParams.get('FID_INPUT_ISCD')).sort(),['0001','1001']);
  assert.ok(!JSON.stringify(one).includes('TEST_ONLY'));
});

test('continuation uses its header, deduplicates overlapping pages and later refreshes retain earlier bars',async()=>{
  const f=fixture((_call,index)=>index===1?ok({rt_cd:'0',output2:[bar('10:02',3350),bar('10:01',3349)]},'M'):
    index===2?ok({rt_cd:'0',output2:[bar('10:01',3000),bar('10:00',3348)]}):
    ok({rt_cd:'0',output2:[bar('10:03',3351),bar('10:02',3350)]},'M'));
  const first=await f.client.series('KOSPI','1m');assert.equal(first.length,3);assert.equal(first[1].close,3349);
  assert.equal(f.calls[1].headers.tr_cont,'N');assert.equal(f.calls[1].url.searchParams.get('FID_INPUT_HOUR_1'),'60');
  f.setClock(clock('10:03')+20_000);
  const next=await f.client.series('KOSPI','1m');
  assert.equal(f.calls.length,3);assert.equal(next.length,4);assert.equal(next[0].date,stamp('10:00'));assert.equal(next.at(-1).close,3351);
});

test('repeated continuation pages are bounded, and unavailable KIS never manufactures minute data',async()=>{
  const repeated=fixture(()=>ok({rt_cd:'0',output2:[bar('10:00')]},'M'));
  assert.equal((await repeated.client.series('KOSPI','1m')).length,1);assert.equal(repeated.calls.length,2);
  let fail=true;
  const f=fixture(()=>fail?ok({rt_cd:'1'}):ok({rt_cd:'0',output2:[bar('10:01')]}));
  assert.equal(await f.client.series('KOSPI','1m'),null);assert.equal(await f.client.series('KOSPI','5m'),null);assert.equal(f.calls.length,1);
  fail=false;f.setClock(clock('10:03')+20_000);assert.equal((await f.client.series('KOSPI','1m')).at(-1).date,stamp('10:01'));
  const empty=kis.createClient({env:{},fetchImpl:()=>{throw new Error('No external requests');}});
  assert.equal(await empty.series('KOSPI','1m'),null);
  assert.equal(await f.client.series('KR:005930:KOSPI','1m'),null);
});

test('minute parsing rejects invalid dates/times/OHLC and keeps actual prior sessions on holidays',()=>{
  const rows=minutes.parseRows([bar('10:01'),bar('10:02',3301),null,
    {...bar('10:01'),stck_bsop_date:'20260230'}, {...bar('10:01'),stck_cntg_hour:'246000'},
    {...bar('10:01'),bstp_nmix_prpr:null},{...bar('10:01'),bstp_nmix_hgpr:'0'},bar('10:04')],clock('10:03'));
  assert.equal(rows.length,2);
  const holiday=minutes.parseRows([bar('15:30')],Date.parse('2026-10-24T10:00:00+09:00'));
  assert.equal(holiday[0].date,stamp('15:30'));
});

test('auction gap and 15:31 close release apply to KIS, with 120-minute bins anchored at 09:00',()=>{
  const input=['09:00','09:01','10:59','11:00','15:19','15:20','15:29','15:30'].map((time,i)=>bar(time,3300+i));
  const before=minutes.parseRows(input,clock('15:30'));
  assert.deepEqual(before.map(row=>row.date),['09:00','09:01','10:59','11:00','15:19'].map(stamp));
  const after=minutes.parseRows(input,clock('15:31'));
  const grouped=minutes.aggregateRows(after,120);
  assert.equal(grouped[0].date,stamp('09:00'));assert.equal(grouped[0].open,3299);assert.equal(grouped[0].close,3302);
  assert.equal(grouped[0].volume,30);assert.equal(grouped[1].date,stamp('11:00'));
  assert.equal(grouped.at(-1).date,stamp('15:30'));assert.equal(grouped.at(-1).close,3307);
});

test('KIS success wins over public chart sources and Naver supplementation cannot overwrite KIS OHLC',async()=>{
  const rows=minutes.parseRows([bar('10:01')],clock('10:03'));let reads=0,publicCalls=0;
  const source=fs.readFileSync(path.join(__dirname,'..','tradingview-data.js'),'utf8');
  const context=vm.createContext({module:{exports:{}},require:id=>id==='./kis-market-data'?{series:async()=>{reads++;return rows;}}:
    id==='./korea-index-session'?{createReader:()=>({supplement:async()=>{publicCalls++;return[];}})}:
    id==='./stock-search'?require('../stock-search'):id==='./us-market-session'?require('../us-market-session'):class{},
    fetch:async()=>{throw new Error('Public fallback must not run');},setTimeout,clearTimeout,console,Buffer});
  vm.runInContext(source,context);
  assert.equal(await context.module.exports.fetchUnifiedSeries('KOSPI','1m'),rows);
  assert.equal(await context.module.exports.supplementKoreanIndexMinutes('KOSPI',rows,'1m'),rows);
  assert.equal(reads,1);assert.equal(publicCalls,0);
  await context.module.exports.supplementKoreanIndexMinutes('KOSPI',[{...rows[0],source:'public'}],'1m');assert.equal(publicCalls,1);
});
