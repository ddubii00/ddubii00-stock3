'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createStore}=require('../shared-stock-store'),list=require('../stock-chart-list');
const search=require('../stock-search'),picker=require('../stock-chart-picker'),engine=require('../market-regime'),kis=require('../kis-market-data');
const apple={name:'Apple Inc.',code:'AAPL',market:'NASDAQ',key:'US:AAPL:NASDAQ'};
const coke={name:'Coca-Cola',code:'KO',market:'NYSE',key:'US:KO:NYSE'};
const ok=body=>({ok:true,json:async()=>body});
async function disk(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock3-shared-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return {STOCK3_STOCK_LIST_PATH:path.join(dir,'chart-stocks.json')};
}
test('two computers share adds, ordering, deletion and an intentional empty list across server restarts',async t=>{
  const env=await disk(t),a=createStore({env}),b=createStore({env});
  assert.equal((await a.read()).initialized,false);
  await a.update({type:'init',items:list.DEFAULTS});
  await Promise.all([a.update({type:'add',stock:apple}),b.update({type:'add',stock:coke})]);
  let state=await b.read();assert.equal(state.items.length,4);
  await b.update({type:'move',slot:state.items[3].slot,direction:-1});
  assert.deepEqual((await a.read()).items.map(row=>row.key),(await b.read()).items.map(row=>row.key));
  for(const item of state.items) await a.update({type:'remove',slot:item.slot});
  assert.deepEqual((await createStore({env}).read()).items,[]);
  await b.update({type:'init',items:list.DEFAULTS});
  assert.deepEqual((await a.read()).items,[],'stale browser initialization must never replace a saved empty list');
});
test('only the first successful browser migrates its old list',async t=>{
  const env=await disk(t),a=createStore({env}),b=createStore({env});
  const custom=list.change(list.DEFAULTS,{type:'add',stock:apple});
  await a.update({type:'init',items:custom});await b.update({type:'init',items:list.DEFAULTS});
  assert.deepEqual((await b.read()).items,custom);
  await assert.rejects(a.update({type:'move',slot:'../bad',direction:1}),{status:400});
  await assert.rejects(a.update({type:'add',stock:{...apple,key:'US:https://bad:NASDAQ'}}),{status:400});
  assert.deepEqual(list.clean([{...apple,slot:'KOSPI'}]),[],'stock slots cannot collide with index chart IDs');
});
test('a restart recovers a dead worker lock without resetting its saved list',async t=>{
  const env=await disk(t),store=createStore({env});
  await store.update({type:'init',items:list.DEFAULTS});
  await fs.writeFile(`${env.STOCK3_STOCK_LIST_PATH}.lock`,JSON.stringify({pid:2147483647}));
  await store.update({type:'add',stock:apple});
  assert.equal((await store.read()).items.length,3);
});
test('read-only writes return failure without claiming a saved edit or losing the previous list',async t=>{
  const env=await disk(t);await createStore({env}).update({type:'init',items:list.DEFAULTS});
  let warned=0;
  const store=createStore({env,io:{...fs,writeFile:async()=>{throw Object.assign(new Error('Read only'),{code:'EROFS'});}},warn:()=>warned++});
  await assert.rejects(store.update({type:'add',stock:apple}),{status:503});
  assert.ok(warned>0);assert.deepEqual((await store.read()).items,list.DEFAULTS);
  const serverless=createStore({env:{VERCEL:'1'},warn:()=>{}});
  await assert.rejects(serverless.read(),{status:503});await assert.rejects(serverless.update({type:'add',stock:apple}),{status:503});
});
test('serverless Redis REST compare-and-set retries concurrent changes and never touches disk',async()=>{
  let raw=null,cas=0;const commands=[];
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://example.invalid/redis');assert.equal(options.headers.authorization,'Bearer TEST_ONLY_REDIS');
    const cmd=JSON.parse(options.body);commands.push(cmd[0]);
    if(cmd[0]==='GET')return ok({result:raw});
    assert.equal(cmd[0],'EVAL');cas++;
    if(raw!==cmd[4]){if(!(raw===null&&cmd[4]===''))return ok({result:0});}
    raw=cmd[5];return ok({result:1});
  };
  const settings={env:{VERCEL:'1',STOCK3_LIST_REST_URL:'https://example.invalid/redis',STOCK3_LIST_REST_TOKEN:'TEST_ONLY_REDIS'},fetchImpl,io:new Proxy({},{get(){throw new Error('No disk access');}})};
  const a=createStore(settings),b=createStore(settings);
  await a.update({type:'init',items:[]});
  await Promise.all([a.update({type:'add',stock:apple}),b.update({type:'add',stock:coke})]);
  assert.equal((await a.read()).items.length,2);assert.ok(cas>=4);assert.ok(commands.includes('EVAL'));
});
test('independent clients sync the server list and keep their last confirmed list when saving fails',async t=>{
  const store=createStore({env:await disk(t)});await store.update({type:'init',items:[]});
  let aState,bState,fail=false,errors=0;
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'/stock3-7/api/chart-stocks');assert.equal(options.cache,'no-store');
    if(fail)return{ok:false,json:async()=>({ok:false,error:'저장 실패'})};
    return ok({ok:true,...(options.method==='POST'?await store.update(JSON.parse(options.body)):await store.read())});
  };
  const settings={fetchImpl,urlFor:url=>`/stock3-7${url}`,onError:()=>errors++};
  const a=list.sharedClient({...settings,onState:state=>aState=state}),b=list.sharedClient({...settings,onState:state=>bState=state});
  await Promise.all([a.load(),b.load()]);assert.deepEqual(bState.items,[]);
  await a.apply({type:'add',stock:apple});await b.load();assert.deepEqual(aState.items,bState.items);
  fail=true;await assert.rejects(b.apply({type:'remove',slot:bState.items[0].slot}));
  assert.equal(bState.items.length,1);assert.equal(errors,1);
});
test('US stock and ETF search validates source exchange/tickers and supports Korean company aliases',async()=>{
  const calls=[];
  const find=search.createSearch({universe:async()=>[],fetchImpl:async url=>{
    calls.push(new URL(url));return ok({quotes:[
      {symbol:'AAPL',shortname:'Apple Inc.',exchange:'NMS',quoteType:'EQUITY'},
      {symbol:'BRK-B',longname:'Berkshire Hathaway',exchange:'NYQ',quoteType:'EQUITY'},
      {symbol:'SPY',shortname:'SPDR S&P 500',exchange:'PCX',quoteType:'ETF'},
      {symbol:'^GSPC',exchange:'NMS',quoteType:'INDEX'},
      {symbol:'AAPL.L',exchange:'LSE',quoteType:'EQUITY'},
      {symbol:'../bad',exchange:'NMS',quoteType:'EQUITY'}]});
  }});
  const rows=await find('애플');assert.equal(calls[0].searchParams.get('q'),'AAPL');assert.equal(rows.length,3);
  assert.equal(rows[0].key,apple.key);assert.ok(rows.every(picker.valid));assert.equal(search.parseStockKey(rows[1].key).yahoo,'BRK-B');
  assert.equal(list.change([],{type:'add',stock:rows[1]})[0].slot,'STOCK_BRK_B_NYSE');
  for(const key of ['US:AAPL:KOSPI','US:../AAPL:NYSE','US:AAPL:NASDAQ/','US:AAPL.L:LSE'])assert.equal(search.parseStockKey(key),null);
});
test('US search and domestic search fail independently; total source failure is explicit',async()=>{
  const fail=async()=>{throw new Error('offline');};
  const good=async()=>ok({quotes:[{symbol:'AAPL',shortname:'Apple',exchange:'NMS',quoteType:'EQUITY'}]});
  assert.equal((await search.createSearch({universe:fail,fetchImpl:good})('AAPL'))[0].code,'AAPL');
  const universe=async()=>[{code:'005930',name:'삼성전자',marketType:'KOSPI'}];
  assert.equal((await search.createSearch({universe,fetchImpl:fail})('삼성'))[0].code,'005930');
  await assert.rejects(search.createSearch({universe:fail,fetchImpl:fail})('AAPL'));
});
test('US stock KIS quotes preserve dollar decimals and use their own exchange codes; daily history falls back',async()=>{
  const calls=[];
  const client=kis.createClient({env:{KIS_APP_KEY:'TEST_ONLY_KEY',KIS_APP_SECRET:'TEST_ONLY_SECRET'},tokenProvider:async()=> 'TEST_ONLY_MEMORY',fetchImpl:async(url,options)=>{
    calls.push({url:new URL(url),options});return ok({rt_cd:'0',output:{last:'251.34',base:'250.12',rate:'0.49'}});
  }});
  for(const stock of [apple,coke]){
    const value=await client.quote(stock.key);assert.equal(value.price,251.34);assert.equal(value.previousClose,250.12);
    assert.equal(calls.at(-1).url.pathname,'/uapi/overseas-price/v1/quotations/price');assert.equal(calls.at(-1).options.headers.tr_id,'HHDFS00000300');
    assert.equal(calls.at(-1).url.searchParams.get('EXCD'),stock.market==='NASDAQ'?'NAS':'NYS');
  }
  assert.equal(await client.series(apple.key),null);assert.equal(calls.length,2);
  assert.equal(engine.confirmedRows([{date:'2026-10-19',close:250}],apple.key,'2026-10-19T19:59:00Z').length,0);
  assert.equal(engine.confirmedRows([{date:'2026-10-19',close:250}],apple.key,'2026-10-19T20:10:00Z').length,1);
});
test('US chart history selects the exact ticker and keeps a US session date from Yahoo',async()=>{
  const context=vm.createContext({module:{exports:{}},URL,Buffer,setTimeout,clearTimeout,
    require:id=>id==='./kis-market-data'?{series:async()=>null}:id==='./stock-search'?search:class{constructor(){throw new Error('Unexpected WebSocket');}},
    fetch:async url=>{assert.match(url,/chart\/AAPL\?/);return ok({chart:{result:[{meta:{gmtoffset:-14400},timestamp:[Date.parse('2026-10-16T13:30:00Z')/1000],indicators:{quote:[{open:[250],high:[252],low:[249],close:[251.34]}]}}]}});}
  });
  vm.runInContext(await fs.readFile(path.join(__dirname,'..','tradingview-data.js'),'utf8'),context);
  const rows=await context.module.exports.fetchUnifiedSeries(apple.key);assert.equal(rows[0].date,'2026-10-16');assert.equal(rows[0].close,251.34);
});
test('shared-list API authenticates reads and edits, validates JSON and reports storage failures',async()=>{
  const source=await fs.readFile(path.join(__dirname,'..','api','chart-stocks.js'),'utf8');
  let state={revision:1,initialized:true,items:[]},calls=0,fail=false;
  const store={read:async()=>{calls++;if(fail)throw Object.assign(new Error('공유 저장소 확인'),{status:503});return state;},update:async action=>{calls++;if(fail)throw Object.assign(new Error('저장 권한 확인'),{status:503});state={...state,revision:2,items:list.change(state.items,action)};return state;}};
  const context=vm.createContext({Buffer,module:{exports:{}},require:id=>id==='../shared-stock-store'?store:require('../access-control')});
  vm.runInContext(source,context);
  async function run(method,body,auth=true){
    const res={setHeader(){},end(body){this.body=JSON.parse(body);},status(code){this.statusCode=code;return this;},json(body){this.body=body;return body;}};
    await context.module.exports({method,body,headers:auth?{'x-stock3-password':'1222'}:{}},res);return res;
  }
  assert.equal((await run('GET',undefined,false)).statusCode,401);assert.equal(calls,0);
  assert.equal((await run('POST','{bad')).statusCode,400);assert.equal(calls,0);
  assert.equal((await run('DELETE')).statusCode,405);
  assert.equal((await run('POST',{type:'add',stock:apple})).body.items.length,1);
  assert.equal((await run('GET')).body.items[0].key,apple.key);
  fail=true;assert.equal((await run('POST',{type:'remove',slot:state.items[0].slot})).statusCode,503);
});
