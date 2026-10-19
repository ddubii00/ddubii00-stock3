'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const access=require('../access-control'),list=require('../stock-chart-list'),header=require('../market-header');
const root=path.join(__dirname,'..');
const samsung=list.DEFAULTS[0],hynix=list.DEFAULTS[1];
const sdi={name:'삼성SDI',code:'006400',market:'KOSPI',key:'KR:006400:KOSPI'};
const electro={name:'삼성전기',code:'009150',market:'KOSPI',key:'KR:009150:KOSPI'};
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=value;},status(value){this.statusCode=value;return this;},json(value){this.body=JSON.stringify(value);return value;}});

test('server access PIN rejects missing/wrong values and honors environment overrides',()=>{
  const req=value=>({headers:{'x-stock3-password':value}});
  assert.equal(access.authorized(req('1222'),{}),true);
  for(const value of [null,'','1111','1222 ','x'.repeat(129),['1222']])assert.equal(access.authorized(req(value),{}),false);
  assert.equal(access.authorized(req('1222'),{STOCK3_PASSWORD:'TEST_ONLY_PIN'}),false);
  assert.equal(access.authorized(req('TEST_ONLY_PIN'),{STOCK3_PASSWORD:'TEST_ONLY_PIN'}),true);
  assert.equal(access.authorized(req('TEST_ONLY_PIN'),{STOCK5_PASSWORD:'TEST_ONLY_PIN'}),true);
});
test('all public Vercel API handlers reject anonymous calls before accessing source data',async()=>{
  for(const name of fs.readdirSync(path.join(root,'api')).filter(name=>name.endsWith('.js'))){
    const res=response();
    await require(path.join(root,'api',name))({headers:{},url:'/api/chart',query:{}},res);
    assert.equal(res.statusCode,401,name);assert.equal(res.headers['Cache-Control'],'no-store',name);
    assert.equal(JSON.parse(res.body).ok,false,name);
  }
});
test('Oracle core and both flow wrappers reject anonymous API calls without touching persisted files',async()=>{
  for(const filename of ['server.js','kis-flow-gateway.js','kis-flow-display.js']){
    let callback;let reads=0;
    const context=vm.createContext({module:{exports:{}},__dirname:root,process:{env:{},on(){}},URL,Buffer,console,setTimeout,clearTimeout,setInterval,
      require:id=>{
        if(id==='./access-control')return access;
        if(id==='http')return{createServer(fn){callback=fn;return{};}};
        if(id==='path')return path;
        if(id==='fs')return{readFileSync(){reads++;throw new Error('Protected reads forbidden');}};
        if(id==='child_process')return{};
        if(id==='ws'||id.startsWith('./'))return{};
        throw new Error(`Unexpected import ${id}`);
      }});
    vm.runInContext(fs.readFileSync(path.join(root,filename),'utf8')+(filename==='server.js'?'':'\nmodule.exports.request=handleRequest;'),context);
    const res=response();await (callback||context.module.exports.request)({url:'/stock3-7/api/extra-chart?kind=kospi-investor-minute',headers:{host:'localhost'}},res);
    assert.equal(res.statusCode,401,filename);assert.equal(reads,0,filename);
  }
});
test('stock list defaults, a saved empty list and malformed storage have distinct behavior',()=>{
  assert.deepEqual(list.read(null,'list'),list.DEFAULTS);
  assert.deepEqual(list.read({getItem:()=> '[]'},'list'),[]);
  assert.deepEqual(list.read({getItem:()=> '{broken'},'list'),list.DEFAULTS);
  assert.deepEqual(list.read({getItem(){throw new Error('read-only');}},'list'),list.DEFAULTS);
  const migrated=list.read(null,'list',(slot,initial)=>slot==='SAMSUNG_DAILY'?electro:initial);
  assert.equal(migrated[0].key,electro.key);assert.equal(migrated[0].slot,'SAMSUNG_DAILY');
});
test('adding four stocks, removal and explicit ordering persist without duplicate codes or DOM slots',()=>{
  let items=list.change(list.DEFAULTS,{type:'add',stock:sdi});items=list.change(items,{type:'add',stock:electro});
  assert.equal(items.length,4);assert.equal(new Set(items.map(item=>item.slot)).size,4);
  assert.equal(list.change(items,{type:'add',stock:sdi}).length,4);
  const slot=items[3].slot;items=list.change(items,{type:'move',slot,direction:-1});
  assert.deepEqual(items.map(item=>item.name),['삼성전자','SK하이닉스','삼성전기','삼성SDI']);
  assert.deepEqual(list.read({getItem:()=>JSON.stringify(items)},'list'),items);
  items=list.change(items,{type:'remove',slot:'SAMSUNG_DAILY'});assert.equal(items.length,3);
  const renamed=list.change(items,{type:'replace',slot:'SKHYNIX_DAILY',stock:sdi});
  assert.deepEqual(renamed,items,'replacing with an already-present code is ignored');
  assert.deepEqual(list.DEFAULTS.map(item=>item.name),['삼성전자','SK하이닉스']);
});
test('stock list sanitization rejects malicious names/slots and caps polling to twenty distinct symbols',()=>{
  const items=Array.from({length:25},(_,i)=>({name:`종목${i}`,code:String(i).padStart(6,'0'),market:'KOSPI',key:`KR:${String(i).padStart(6,'0')}:KOSPI`,slot:`STOCK_${i}`}));
  assert.equal(list.clean(items).length,20);
  assert.equal(list.clean([{...samsung,slot:'../escape'},{...hynix,key:'https://example.com'}]).length,0);
  assert.deepEqual(list.clean([samsung,{...hynix,slot:samsung.slot}]),[samsung]);
});
function ticker(){
  const flags=new Set();return{nodes:{'.ticker-price':{textContent:'-'},'.ticker-rate':{textContent:'-'}},
    classList:{add:key=>flags.add(key),remove:key=>flags.delete(key),toggle(key,on){on?flags.add(key):flags.delete(key);},contains:key=>flags.has(key)},
    querySelector(key){return this.nodes[key];}};
}
test('ticker preserves real zero change and marks missing/stale quotes without fabricating a zero price',()=>{
  const node=ticker();header.render(node,{price:3349.12,changePercent:0,source:'KIS'});
  assert.equal(node.nodes['.ticker-rate'].textContent,'0.00%');assert.equal(node.nodes['.ticker-price'].textContent,'3,349.12');
  header.render(node,null);assert.equal(node.nodes['.ticker-price'].textContent,'3,349.12');assert.equal(node.classList.contains('stale'),true);
  header.render(node,{price:3340,changePercent:-1,source:'Yahoo Finance',delayed:true});
  assert.equal(node.classList.contains('down'),true);assert.match(node.title,/지연/);assert.equal(node.classList.contains('stale'),false);
});
test('20-second polling never overlaps requests and suppresses background-page polling',async()=>{
  let timer,resolveFetch,calls=0;
  const fixtureHeader={getBoundingClientRect:()=>({height:45}),querySelectorAll:()=>[]};
  const document={hidden:false,getElementById:()=>fixtureHeader,documentElement:{style:{setProperty(){}}},addEventListener(){}};
  const browser={document,ResizeObserver:class{observe(){}},setInterval(fn,ms){timer=fn;assert.equal(ms,20_000);return 1;},clearInterval(){},fetch:async()=>{calls++;return new Promise(resolve=>{resolveFetch=resolve;});}};
  const context=vm.createContext(browser);context.window=context;context.globalThis=context;
  vm.runInContext(fs.readFileSync(path.join(root,'market-header.js'),'utf8'),context);
  context.MarketHeader.start({urlFor:value=>value,getStocks:()=>[samsung]});
  assert.equal(calls,1);await timer();assert.equal(calls,1);
  resolveFetch({ok:true,json:async()=>({ok:true,quotes:[]})});await new Promise(resolve=>setImmediate(resolve));
  document.hidden=true;await timer();assert.equal(calls,1);
  document.hidden=false;const pending=timer();assert.equal(calls,2);resolveFetch({ok:true,json:async()=>({ok:true,quotes:[]})});await pending;
});

test('login waits for server acceptance before starting API calls and never forwards the PIN to another origin',async()=>{
  const nodes={accessGate:{hidden:false},marketHeader:{hidden:true},accessError:{textContent:''},accessPassword:{value:''}};
  const button={disabled:false};let submit;
  nodes.accessForm={addEventListener(type,fn){if(type==='submit')submit=fn;},querySelector:()=>button};
  const calls=[],storage=new Map();
  const location={pathname:'/stock3-7/',href:'http://127.0.0.1:8000/stock3-7/',origin:'http://127.0.0.1:8000',reload(){throw new Error('Unexpected reload');}};
  const context=vm.createContext({URL,Headers,location,document:{getElementById:key=>nodes[key],body:{removeAttribute(){}}},localStorage:{getItem:key=>storage.get(key),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch:async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('/api/access'))return{ok:options.headers['x-stock3-password']==='1222',json:async()=>({ok:true})};
    return{ok:true,status:200,json:async()=>({ok:true})};
  }});context.window=context;
  vm.runInContext(fs.readFileSync(path.join(root,'access-client.js'),'utf8'),context);
  const waiting=context.fetch('/stock3-7/api/chart?key=KOSPI');assert.equal(calls.length,0);
  nodes.accessPassword.value='1111';await submit({preventDefault(){}});
  assert.equal(nodes.accessGate.hidden,false);assert.match(nodes.accessError.textContent,/접속 암호/);assert.equal(calls.length,1);
  nodes.accessPassword.value='1222';await submit({preventDefault(){}});await waiting;
  assert.equal(nodes.accessGate.hidden,true);assert.equal(nodes.marketHeader.hidden,false);assert.equal(calls.at(-1).options.headers.get('x-stock3-password'),'1222');
  await context.fetch('https://example.com/api/data');assert.equal(calls.at(-1).options.headers,undefined);
  assert.equal([...storage.values()][0],'1222');
});

test('readding a stock after renaming its previous chart generates a fresh unique DOM slot',()=>{
  let items=list.change([],{type:'add',stock:sdi});
  const firstSlot=items[0].slot;
  items=list.change(items,{type:'replace',slot:firstSlot,stock:electro});
  items=list.change(items,{type:'add',stock:sdi});
  assert.equal(items.length,2);assert.notEqual(items[0].slot,items[1].slot);
  assert.deepEqual(items.map(item=>item.key),[electro.key,sdi.key]);
});
test('gateway passes KIS environment aliases to the core, isolates flow collection, and shares its token only over IPC',async()=>{
  const source=fs.readFileSync(path.join(root,'kis-flow-gateway.js'),'utf8');
  const block=source.slice(source.indexOf('function spawnCore() {'),source.indexOf('\nlet child =',source.indexOf('function spawnCore() {')));
  const listeners={};let spawnOptions,sent;
  const child={connected:true,on:(name,fn)=>{listeners[name]=fn;},send:(message,done)=>{sent=message;done();}};
  const context=vm.createContext({process:{env:{KIS_APP_KEY:'TEST_ONLY_KEY',KIS_APP_SECRET:'TEST_ONLY_SECRET'},execPath:'node'},CORE_PORT:18000,ROOT:'/mock',path,state:{},shuttingDown:false,console,
    spawn:(binary,args,options)=>{spawnOptions=options;return child;},getAccessTokenInfo:async()=>({value:'TEST_ONLY_IPC_TOKEN',expiresAt:9999999999999})});
  vm.runInContext(block,context);context.spawnCore();
  assert.equal(spawnOptions.env.KIS_APP_KEY,'TEST_ONLY_KEY');assert.equal(spawnOptions.env.STOCK3_KIS_FLOW_OWNER,'gateway');
  assert.equal(spawnOptions.stdio[3],'ipc');
  await listeners.message({type:'stock3-kis-auth-request',requestId:'TEST_REQUEST'});
  assert.equal(sent.value,'TEST_ONLY_IPC_TOKEN');assert.equal(sent.requestId,'TEST_REQUEST');
});
