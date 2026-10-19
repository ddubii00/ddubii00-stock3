'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const kis=require('../kis-market-data'),{createQuotes}=require('../market-quotes');
const ENV={KIS_APP_KEY:'TEST_ONLY_APP_KEY',KIS_APP_SECRET:'TEST_ONLY_APP_SECRET'};
const ok=body=>({ok:true,json:async()=>body});
function mock(load){let tokens=0,calls=[];const fetchImpl=async(url,options)=>{
  if(String(url).endsWith('/oauth2/tokenP')){tokens++;return ok({access_token:'TEST_ONLY_ACCESS_TOKEN',expires_in:86400});}
  calls.push({url:new URL(url),headers:options.headers});return ok(await load(new URL(url),options));};
  return{fetchImpl,calls,tokens:()=>tokens};}

test('missing KIS environment never issues a request and existing credential aliases remain supported',async()=>{
  const client=kis.createClient({env:{},fetchImpl:()=>{throw new Error('Network forbidden');}});
  assert.equal(await client.quote('KOSPI'),null);assert.equal(await client.series('KOSPI'),null);
  assert.equal(kis.credentials({KIS_APPKEY:'TEST',KIS_APPSECRET:'TEST'}).appKey,'TEST');
  assert.equal(kis.credentials({APP_KEY:'TEST',APP_SECRET:'TEST'}).appKey,'TEST');
});
test('concurrent readers share one memory token, quote requests are deduplicated and index units are unscaled',async()=>{
  const upstream=mock(()=>({rt_cd:'0',output:{bstp_nmix_prpr:'3349.12',bstp_nmix_prdy_ctrt:'0.03',prdy_nmix:'3348.12'}}));
  const client=kis.createClient({env:ENV,fetchImpl:upstream.fetchImpl});
  const quotes=await Promise.all([client.quote('KOSPI'),client.quote('^KS11'),client.quote('KOSDAQ')]);
  assert.equal(upstream.tokens(),1);assert.equal(upstream.calls.length,2);assert.equal(quotes[0].price,3349.12);assert.equal(quotes[0].source,'KIS');
  assert.equal(upstream.calls[0].headers.tr_id,'FHPUP02100000');assert.equal(upstream.calls[0].url.searchParams.get('FID_INPUT_ISCD'),'0001');
  assert.ok(!JSON.stringify(quotes).includes('TEST_ONLY'));
});
test('stock current prices preserve the previous close and a true zero daily change',async()=>{
  const upstream=mock(()=>({rt_cd:'0',output:{stck_prpr:'80000',stck_prdy_clpr:'80000',prdy_ctrt:'0'}}));
  const client=kis.createClient({env:ENV,fetchImpl:upstream.fetchImpl});const quote=await client.quote('KR:005930:KOSPI');
  assert.equal(quote.price,80000);assert.equal(quote.previousClose,80000);assert.equal(quote.changePercent,0);
  assert.equal(upstream.calls[0].headers.tr_id,'FHKST01010100');assert.equal(upstream.calls[0].url.searchParams.get('FID_INPUT_ISCD'),'005930');
});
test('overseas indices/FX use their own market codes, and NASDAQ100 cannot replace the composite',async()=>{
  const upstream=mock(url=>({rt_cd:'0',output1:{ovrs_nmix_prpr:'100',ovrs_nmix_prdy_clpr:'99',prdy_ctrt:'1.01',hts_kor_isnm:url.searchParams.get('FID_INPUT_ISCD')==='TEST_NDX'?'나스닥100':'정상'}}));
  const client=kis.createClient({env:{...ENV,KIS_NASDAQ_INDEX_CODE:'TEST_NDX'},fetchImpl:upstream.fetchImpl});
  assert.equal(await client.quote('NASDAQ'),null);assert.equal((await client.quote('SP500')).source,'KIS');
  await client.quote('USDKRW');assert.equal(upstream.calls.at(-1).url.searchParams.get('FID_COND_MRKT_DIV_CODE'),'X');
  assert.equal(upstream.calls.at(-1).headers.tr_id,'FHKST03030200');
  assert.equal(await client.series('BTC'),null);assert.equal(await client.series('KOSPI','1m'),null);
});
test('failed KIS quote requests are throttled, recover after the cache window, and fall back visibly',async()=>{
  let clock=0,fail=true;
  const upstream=mock(()=>fail?{rt_cd:'1'}:{rt_cd:'0',output:{stck_prpr:'123',prdy_ctrt:'0'}});
  const client=kis.createClient({env:ENV,fetchImpl:upstream.fetchImpl,now:()=>clock});
  assert.equal(await client.quote('KR:005930:KOSPI'),null);assert.equal(await client.quote('KR:005930:KOSPI'),null);assert.equal(upstream.calls.length,1);
  clock=20_000;fail=false;assert.equal((await client.quote('KR:005930:KOSPI')).price,123);
  const publicSource=createQuotes({kisClient:{quote:async()=>null},fetchImpl:async()=>ok({chart:{result:[{meta:{regularMarketPrice:100,chartPreviousClose:100,regularMarketTime:1000}}]}})});
  const quote=await publicSource.quote('KOSPI');assert.equal(quote.source,'Yahoo Finance');assert.equal(quote.delayed,true);assert.equal(quote.changePercent,0);assert.equal(quote.asOf,new Date(1000000).toISOString());
});
function history(){const rows=[];for(let d=new Date('2024-01-01T00:00:00Z');rows.length<650;d.setUTCDate(d.getUTCDate()+1)){if([0,6].includes(d.getUTCDay()))continue;const price=100+rows.length;rows.push({stck_bsop_date:d.toISOString().slice(0,10).replace(/-/g,''),stck_clpr:String(price),stck_oprc:String(price),stck_hgpr:String(price+2),stck_lwpr:String(price-2),acml_vol:'100'});}return rows;}
test('KIS chart pagination provides MA200 history and later refreshes only the current page',async()=>{
  let clock=Date.parse('2026-10-20T00:00:00Z');const rows=history();
  const upstream=mock(url=>({rt_cd:'0',output2:rows.filter(row=>row.stck_bsop_date<=url.searchParams.get('FID_INPUT_DATE_2')).slice(-100).reverse()}));
  const client=kis.createClient({env:ENV,fetchImpl:upstream.fetchImpl,now:()=>clock});
  const first=await client.series('KR:005930:KOSPI');assert.equal(first.length,520);assert.equal(upstream.calls.length,6);
  assert.ok(first[0].date<first.at(-1).date);assert.equal(first.at(-1).close,749);
  assert.ok(upstream.calls.every(call=>call.headers.tr_id==='FHKST03010100'&&call.url.searchParams.get('FID_ORG_ADJ_PRC')==='0'));
  clock+=20_000;rows.at(-1).stck_clpr='750';
  const second=await client.series('KR:005930:KOSPI');assert.equal(second.length,520);assert.equal(second.at(-1).close,750);assert.equal(upstream.calls.length,7);assert.equal(upstream.tokens(),1);
});
test('insufficient, malformed, and zero KIS OHLC responses cannot displace the existing chart source',async()=>{
  const upstream=mock(()=>({rt_cd:'0',output2:[{stck_bsop_date:'20261019',stck_clpr:'0',stck_oprc:'1',stck_hgpr:'1',stck_lwpr:'1'}]}));
  const client=kis.createClient({env:ENV,fetchImpl:upstream.fetchImpl});assert.equal(await client.series('KOSPI'),null);
});
test('core token provider reuses the gateway token without a second OAuth request',async()=>{
  let provided=0;
  const client=kis.createClient({env:ENV,tokenProvider:async()=>{provided++;return 'TEST_ONLY_IPC_TOKEN';},fetchImpl:async(url,options)=>{
    assert.ok(!String(url).includes('oauth2'));assert.equal(options.headers.authorization,'Bearer TEST_ONLY_IPC_TOKEN');return ok({rt_cd:'0',output:{stck_prpr:'100',prdy_ctrt:'0'}});
  }});
  await Promise.all([client.quote('KR:005930:KOSPI'),client.quote('KR:000660:KOSPI')]);assert.equal(provided,1);
});
test('snapshot returns all five header markets and every unique selected stock, without replacing missing prices by zero',async()=>{
  const calls=[];const quotes=createQuotes({kisClient:{quote:async key=>{calls.push(key);return key==='KOSDAQ'?null:{key,price:100,source:'KIS'};}},fetchImpl:async()=>{throw new Error('Source unavailable');}});
  const result=await quotes.snapshot(['KR:005930:KOSPI','KR:000660:KOSPI','KR:005930:KOSPI']);
  assert.equal(result.pollMs,20000);assert.equal(result.quotes.length,7);assert.equal(result.quotes.find(row=>row.key==='KOSDAQ').quote,null);assert.equal(calls.length,7);
});

test('a core reader uses the parent token expiry instead of caching past its real lifetime',async()=>{
  let clock=0,provided=0;
  const client=kis.createClient({env:ENV,now:()=>clock,tokenProvider:async()=>({value:`TEST_ONLY_${++provided}`,expiresAt:clock+90_000}),fetchImpl:()=>{throw new Error('No OAuth expected');}});
  assert.equal(await client.getAccessToken(),'TEST_ONLY_1');clock=40_000;
  assert.equal(await client.getAccessToken(),'TEST_ONLY_2');assert.equal(provided,2);
});

test('a public quote with a supplied percentage preserves the previous-price display even when metadata omits previous close',async()=>{
  const client=createQuotes({kisClient:{quote:async()=>null},fetchImpl:async()=>ok({chart:{result:[{meta:{regularMarketPrice:101,regularMarketChangePercent:1}}]}})});
  assert.equal((await client.quote('KR:005930:KOSPI')).previousClose,100);
});
