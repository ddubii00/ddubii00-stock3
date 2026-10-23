'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const selection=require('../dashboard-selection'),shared=require('../shared-dashboard-selection');
const root=path.join(__dirname,'..');
const slots=['panel:lwchart-KOSPI','panel:chart-btc','panel:watchlistBody','stock:KR:005930:KOSPI'];
const ok=body=>({ok:true,json:async()=>body});
async function environment(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock3-panels-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return{STOCK3_STOCK_LIST_PATH:path.join(dir,'stocks.json')};}

test('selection accepts four distinct panel/stock identities, including deletions, and rejects malformed requests',()=>{
  assert.equal(selection.validSlots(selection.empty()),true);assert.equal(selection.validSlots(slots),true);
  for(const value of [[],slots.slice(0,3),[...slots,null],[slots[0],slots[0],null,null],['panel:../bad',null,null,null],['stock:US:<script>:NASDAQ',null,null,null],{},null])assert.equal(selection.validSlots(value),false);
  assert.equal(selection.validSlots(['stock:US:BRK-B:NYSE',null,null,null]),true);
});

test('two computers share a saved selection and deletions across restart without changing the stock list',async t=>{
  const env=await environment(t),a=shared.createStore({env}),b=shared.createStore({env});
  assert.deepEqual((await a.read()).slots,selection.empty());
  const stocks=require('../shared-stock-store').createStore({env});await stocks.update({type:'init',items:[]});
  await a.update({slots});assert.deepEqual((await b.read()).slots,slots);
  const cleared=[slots[0],null,slots[2],null];await b.update({slots:cleared});
  assert.deepEqual((await shared.createStore({env}).read()).slots,cleared);
  await a.update({slots:selection.empty()});assert.deepEqual((await b.read()).slots,selection.empty());
  assert.deepEqual((await stocks.read()).items,[]);
  await assert.rejects(a.update({slots:[slots[0],slots[0],null,null]}),{status:400});
});

test('read-only storage fails safely and preserves the last confirmed selection',async t=>{
  const env=await environment(t);await shared.createStore({env}).update({slots});let warnings=0;
  const readonly=shared.createStore({env,io:{...fs,writeFile:async()=>{throw Object.assign(new Error('read only'),{code:'EROFS'});}},warn:()=>warnings++});
  await assert.rejects(readonly.update({slots:selection.empty()}),{status:503});assert.ok(warnings>0);
  assert.deepEqual((await shared.createStore({env}).read()).slots,slots);
});

test('Vercel selection uses a separate shared Redis key and never touches disk',async()=>{
  const records=new Map();
  const reader=shared.createStore({env:{VERCEL:'1',KV_REST_API_URL:'https://example.invalid/redis',KV_REST_API_TOKEN:'TEST_ONLY_REDIS'},io:new Proxy({},{get(){throw new Error('Disk forbidden');}}),fetchImpl:async(_url,options)=>{
    const command=JSON.parse(options.body),key=command[0]==='GET'?command[1]:command[3];
    assert.equal(key,'stock3:dashboard-selection:v1');
    if(command[0]==='GET')return ok({result:records.get(key)||null});
    if((records.get(key)||'')!==command[4])return ok({result:0});records.set(key,command[5]);return ok({result:1});
  }});
  await reader.update({slots});assert.deepEqual((await reader.read()).slots,slots);
});

test('separate browser clients receive server choices and failed saves never change the confirmed selection',async t=>{
  const store=shared.createStore({env:await environment(t)});let fail=false,aState,bState;
  const settings={urlFor:url=>`/stock3-7${url}`,fetchImpl:async(url,options)=>{
    assert.equal(url,'/stock3-7/api/dashboard-selection');assert.equal(options.cache,'no-store');
    if(fail&&options.method==='POST')return{ok:false,json:async()=>({ok:false,error:'저장 실패'})};
    return ok({ok:true,...(options.method==='POST'?await store.update(JSON.parse(options.body)):await store.read())});
  }};
  const a=selection.createClient({...settings,onState:state=>aState=state}),b=selection.createClient({...settings,onState:state=>bState=state});
  await a.load();await a.save(slots);await b.load();assert.deepEqual(aState.slots,bState.slots);
  fail=true;await assert.rejects(b.save(selection.empty()),/저장 실패/);assert.deepEqual(bState.slots,slots);
});

test('selection API authenticates reads/writes, validates all four slots, limits size and reports storage failure',async()=>{
  let state={revision:0,slots:selection.empty()},fail=false,reads=0;
  const context=vm.createContext({module:{exports:{}},Buffer,require:id=>id==='../access-control'?require('../access-control'):{read:async()=>{reads++;return state;},update:async action=>{shared.validate(action);if(fail)throw Object.assign(new Error('readonly'),{status:503});return state={revision:state.revision+1,slots:action.slots};}}});
  vm.runInContext(await fs.readFile(path.join(root,'api/dashboard-selection.js'),'utf8'),context);
  async function request(method,body,auth=true){const result={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;},end(body){this.body=JSON.parse(body);}};await context.module.exports({method,body,headers:auth?{'x-stock3-password':'1222'}:{}},result);return result;}
  assert.equal((await request('GET',null,false)).statusCode,401);assert.equal(reads,0);
  assert.equal((await request('GET')).headers['Cache-Control'],'no-store');
  assert.equal((await request('POST',{slots})).code,200);
  assert.equal((await request('POST',{slots:[slots[0],slots[0],null,null]})).code,400);
  assert.equal((await request('POST','x'.repeat(5000))).code,413);
  assert.equal((await request('DELETE')).code,405);
  fail=true;assert.equal((await request('POST',{slots:selection.empty()})).code,503);assert.deepEqual(Array.from(state.slots),slots);
});

// Minimal DOM keeps the real controller's listeners, node moves and save flow testable
// without a browser or any external chart/API source.
class Element{
  constructor(tag='div',type=1){this.tagName=tag.toUpperCase();this.nodeType=type;this.childNodes=[];this.parentNode=null;this.dataset={};this.events={};this.attrs={};this.hidden=false;this.className='';this.textContent='';}
  get parentElement(){return this.parentNode?.nodeType===1?this.parentNode:null;}
  get isConnected(){return this.tagName==='BODY'||Boolean(this.parentNode?.isConnected);}
  appendChild(node){node.remove();node.parentNode=this;this.childNodes.push(node);return node;}
  append(...nodes){nodes.forEach(node=>this.appendChild(node));}
  remove(){if(this.parentNode){this.parentNode.childNodes=this.parentNode.childNodes.filter(node=>node!==this);this.parentNode=null;}}
  before(node){const parent=this.parentNode;node.remove();node.parentNode=parent;parent.childNodes.splice(parent.childNodes.indexOf(this),0,node);}
  replaceWith(node){this.before(node);this.remove();}
  replaceChildren(...nodes){this.childNodes.slice().forEach(node=>node.remove());this.append(...nodes);}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(type,handler){(this.events[type]||=[]).push(handler);}
  async fire(type){for(const handler of this.events[type]||[])await handler({target:this});}
  showModal(){this.open=true;}
  close(){this.open=false;void this.fire('close');}
  matches(selector){if(selector==='[id]')return Boolean(this.id);if(selector==='.chart[id]')return this.className.split(' ').includes('chart')&&Boolean(this.id);return selector[0]==='.'&&this.className.split(' ').includes(selector.slice(1));}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  querySelectorAll(selector){const result=[];for(const child of this.childNodes){if(child.matches?.(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
async function viewFixture(){
  const body=new Element('body'),wrap=new Element(),group=new Element(),compact=new Element(),controls=new Element();wrap.className='wrap';compact.id='compactDashboard';compact.hidden=true;body.append(controls,wrap);wrap.append(compact,group);
  for(const id of ['dashboardSelectionDialog','dashboardSelectionMessage','saveDashboardSelection','dashboardSelectionRows','showAllPanels','showSelectedPanels','openDashboardSelection','closeDashboardSelection']){const node=new Element(id.includes('Dialog')?'dialog':'button');node.id=id;controls.appendChild(node);}
  const cards=slots.map((id,index)=>{const card=new Element('section');card.className='card';const title=new Element();title.className=index===3?'stock-chart-name':'title';title.textContent=['코스피','비트코인 일봉 (BTC/USD)','관심종목 트래커','삼성전자'][index];const chart=new Element();chart.id=id.startsWith('stock:')?'lwchart-SAMSUNG_DAILY':id.slice(6);chart.className='chart';card.append(title,chart);if(id.startsWith('stock:'))card.dataset.stockKey=id.slice(6);group.appendChild(card);return card;});
  const doc={body,hidden:false,events:{},createElement:tag=>new Element(tag),createComment:()=>new Element('comment',8),getElementById:id=>[body,...all(body)].find(node=>node.id===id),querySelectorAll:selector=>selector==='.wrap .card'?wrap.querySelectorAll('.card'):[],addEventListener(type,handler){(this.events[type]||=[]).push(handler);}};
  function all(node){return node.childNodes.flatMap(child=>[child,...all(child)]);}
  let stored={revision:0,slots:selection.empty()},fail=false;
  const context=vm.createContext({document:doc,AbortController,setTimeout,clearTimeout,setInterval(){},fetch:async(_url,options)=>{
    if(options.method==='POST'){if(fail)return{ok:false,json:async()=>({ok:false,error:'저장 실패'})};stored={revision:stored.revision+1,slots:JSON.parse(options.body).slots};}
    return ok({ok:true,...stored});
  }});
  vm.runInContext(await fs.readFile(path.join(root,'dashboard-selection.js'),'utf8'),context);
  const api=context.DashboardSelection.create({urlFor:url=>url});await new Promise(resolve=>setImmediate(resolve));
  return {api,doc,body,wrap,group,compact,cards,node:id=>doc.getElementById(id),stored:()=>stored,setFail:()=>{fail=true;}};
}

function additionalPanels(){
  return [
    ['미국 국채 10년 금리 (주)','lwchart-US10Y_WEEK',true],
    ['Binance 국내주식 30초 시세','binanceKoreaBody',false],
    ['USTECH100 (나스닥100 CFD)','tvchart-USTECH100',true]
  ].map(([name,id,chart])=>{
    const card=new Element('section');card.className='card';
    card.dataset.dashboardId=`panel:${id}`;card.dataset.dashboardTitle=name;
    const title=new Element();title.className='title';title.textContent=name;
    const body=new Element(chart?'div':'tbody');body.id=id;body.className=chart?'chart':'';
    card.append(title,body);return card;
  });
}

test('technical charts, widgets and tables keep selectable identities when library children change',async()=>{
  const f=await viewFixture(),panels=additionalPanels();f.group.append(...panels);
  const noisy=new Element('section');noisy.className='card';
  const title=new Element();title.className='title';title.textContent='추가 차트';
  const invalid=new Element();invalid.className='chart';invalid.id='7-invalid-library-id';
  const valid=new Element();valid.className='chart';valid.id='chart-extra-valid';
  noisy.append(title,invalid,valid);f.group.append(noisy);
  const before=selection.catalog(f.doc);
  for(const panel of panels)assert.equal(before.find(entry=>entry.id===panel.dataset.dashboardId)?.title,panel.dataset.dashboardTitle);
  assert.equal(before.find(entry=>entry.node===noisy)?.id,'panel:chart-extra-valid');
  for(const panel of panels)panel.replaceChildren();
  valid.remove();
  const after=selection.catalog(f.doc);
  for(const panel of panels)assert.equal(after.find(entry=>entry.id===panel.dataset.dashboardId)?.node,panel);
  assert.equal(after.find(entry=>entry.node===noisy)?.id,'panel:chart-extra-valid');
});

test('USTECH100, US10Y and Binance can be chosen, saved and moved into four equal-view slots',async()=>{
  const f=await viewFixture(),panels=additionalPanels();f.group.append(...panels);
  const chosen=[...panels.map(panel=>panel.dataset.dashboardId),slots[0]];
  await f.node('openDashboardSelection').fire('click');
  for(let index=0;index<4;index++){
    const select=f.node(`dashboard-selection-${index}`);
    assert.ok(select.childNodes.some(option=>option.value===chosen[index]&&!option.disabled));
    select.value=chosen[index];await select.fire('change');
  }
  await f.node('saveDashboardSelection').fire('click');assert.deepEqual(f.stored().slots,chosen);
  f.node('dashboardSelectionDialog').close();await f.node('showSelectedPanels').fire('click');
  assert.deepEqual(f.compact.childNodes,[...panels,f.cards[0]]);
  await f.node('showAllPanels').fire('click');assert.deepEqual(f.group.childNodes,[...f.cards,...panels]);
});

test('four dropdowns save, delete and show the same live cards in a 2x2 view; all restores original node order',async()=>{
  const f=await viewFixture();assert.equal(f.body.dataset.dashboardMode,'all');assert.equal(f.compact.hidden,true);
  await f.node('openDashboardSelection').fire('click');
  for(let i=0;i<4;i++){const select=f.node(`dashboard-selection-${i}`);select.value=slots[i];await select.fire('change');}
  const duplicate=f.node('dashboard-selection-1').childNodes.find(option=>option.value===slots[0]);assert.equal(duplicate.disabled,true);
  await f.node('saveDashboardSelection').fire('click');assert.deepEqual(f.stored().slots,slots);
  f.node('dashboardSelectionDialog').close();await f.node('showSelectedPanels').fire('click');
  assert.equal(f.compact.childNodes.length,4);assert.ok(f.cards.every((node,i)=>f.compact.childNodes[i]===node));
  await f.node('showAllPanels').fire('click');assert.deepEqual(f.group.childNodes,f.cards);
  await f.node('openDashboardSelection').fire('click');
  await f.node('dashboardSelectionRows').childNodes[1].childNodes[2].fire('click');await f.node('saveDashboardSelection').fire('click');
  assert.equal(f.stored().slots[1],null);
  await f.node('showSelectedPanels').fire('click');assert.equal(f.compact.childNodes.length,4);assert.equal(f.compact.childNodes[1].className,'card compact-panel-empty');
});

test('a failed save retains the shared selection, and removing a stock never resurrects its old chart',async()=>{
  const f=await viewFixture();await f.node('openDashboardSelection').fire('click');const select=f.node('dashboard-selection-0');select.value=slots[3];await select.fire('change');
  await f.node('saveDashboardSelection').fire('click');await f.node('showSelectedPanels').fire('click');
  f.api.restore();f.cards[3].remove();f.api.catalogChanged();
  assert.equal(f.compact.childNodes[0].className,'card compact-panel-empty');assert.equal(f.cards[3].isConnected,false);
  await f.node('showAllPanels').fire('click');await f.node('openDashboardSelection').fire('click');
  await f.node('dashboardSelectionRows').childNodes[0].childNodes[2].fire('click');f.setFail();await f.node('saveDashboardSelection').fire('click');
  assert.equal(f.stored().slots[0],slots[3]);assert.match(f.node('dashboardSelectionMessage').textContent,/저장되지 않았/);
});
