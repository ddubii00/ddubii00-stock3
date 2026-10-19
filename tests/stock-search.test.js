'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {matchStocks,parseStockKey} = require('../stock-search');
const engine = require('../market-regime');
const picker = require('../stock-chart-picker');
const root = path.join(__dirname,'..');
const universe = [
  {code:'005930',name:'삼성전자',marketType:'KOSPI',marketCap:500},
  {code:'009150',name:'삼성전기',marketType:'KOSPI',marketCap:100},
  {code:'006400',name:'삼성SDI',marketType:'KOSPI',marketCap:200},
  {code:'000660',name:'SK하이닉스',marketType:'KOSPI',marketCap:300},
  {code:'247540',name:'에코프로비엠',marketType:'KOSDAQ',marketCap:150},
  {code:'bad',name:'삼성 가짜',marketType:'KOSPI',marketCap:9999}
];

test('name/code search includes similar stocks and exact matches rank first',()=>{
  assert.deepEqual(matchStocks(universe,' 삼성 ').map(r=>r.name),['삼성전자','삼성SDI','삼성전기']);
  assert.equal(matchStocks(universe,'삼성전기')[0].code,'009150');
  assert.equal(matchStocks(universe,'SK 하이닉스')[0].code,'000660');
  assert.equal(matchStocks(universe,'005930')[0].name,'삼성전자');
  assert.equal(matchStocks(universe,'없는종목').length,0);
  assert.equal(matchStocks(universe,'').length,0);
  assert.ok(matchStocks(Array.from({length:30},(_,i)=>({code:String(i).padStart(6,'0'),name:`삼성${i}`,marketType:'KOSPI'})),'삼성').length<=20);
});

test('only validated Korean codes select KS/KQ chart sources',()=>{
  assert.equal(parseStockKey('KR:005930:KOSPI').yahoo,'005930.KS');
  assert.equal(parseStockKey('KR:247540:KOSDAQ').yahoo,'247540.KQ');
  for(const key of ['KR:ABC:KOSPI','KR:005930:US','KR:005930:KOSPI/../secret','https://host',null]) assert.equal(parseStockKey(key),null);
});

test('Korean stocks use confirmed Korea sessions and retain distinct cycle identities',()=>{
  const rows=[];
  for(let d=new Date('2025-01-01T00:00:00Z');rows.length<122;d.setUTCDate(d.getUTCDate()+1)) if(![0,6].includes(d.getUTCDay())) rows.push({date:d.toISOString().slice(0,10),close:rows.length===121?80:100});
  const samsung=engine.analyze(rows,'KR:005930:KOSPI',{now:'2026-10-19T12:00:00Z'});
  const other=engine.analyze(rows,'KR:009150:KOSPI',{now:'2026-10-19T12:00:00Z'});
  assert.equal(samsung.key,'drawdown20');
  assert.notEqual(samsung.stageSignals[0].id,other.stageSignals[0].id);
  assert.equal(engine.confirmedRows([{date:'2026-10-19',close:100}],'KR:247540:KOSDAQ','2026-10-19T06:39:00Z').length,0);
});

test('reference stock preferences are independent and ignore malformed saved selections',()=>{
  const initial={code:'005930',name:'삼성전자',market:'KOSPI',key:'KR:005930:KOSPI'};
  const selected={code:'009150',name:'삼성전기',market:'KOSPI',key:'KR:009150:KOSPI'};
  const store={getItem:(key)=>key.endsWith('first')?JSON.stringify(selected):null};
  assert.equal(picker.readSelection('first',initial,store).code,'009150');
  assert.equal(picker.readSelection('second',initial,store).code,'005930');
  assert.equal(picker.readSelection('first',initial,{getItem:()=>'{bad'}),initial);
  assert.equal(picker.readSelection('first',initial,{getItem:()=>JSON.stringify({...selected,key:'KR:005930:KOSPI'})}),initial);
  assert.equal(picker.readSelection('first',initial,{getItem(){throw new Error('blocked');}}),initial);
});

test('stock charts load the requested code with mocked upstream calls',async()=>{
  const urls=[];
  const context=vm.createContext({module:{exports:{}},URL,Buffer,setTimeout,clearTimeout,
    require:(id)=>id==='./stock-search'?require('../stock-search'):class{constructor(){throw new Error('Unexpected WebSocket');}},
    fetch:async(url)=>{
      urls.push(url);
      return {ok:true,json:async()=>({chart:{result:[{meta:{gmtoffset:32400},timestamp:[Date.parse('2026-10-16T00:00:00Z')/1000],indicators:{quote:[{open:[123],high:[130],low:[120],close:[125]}]}}]}})};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root,'tradingview-data.js'),'utf8'),context);
  const rows=await context.module.exports.fetchUnifiedSeries('KR:247540:KOSDAQ','1d');
  assert.match(urls[0],/247540\.KQ/);
  assert.match(urls[0],/interval=1d/);
  assert.equal(rows[0].close,125);
  assert.equal(rows[0].date,'2026-10-16');
  const count=urls.length;
  assert.equal(await context.module.exports.fetchUnifiedSeries('KR:bad:KOSPI'),null);
  assert.equal(urls.length,count);
});

test('search endpoint shares real universe matching, handles failures and bounds input',async()=>{
  let calls=0,fail=false;
  const context=vm.createContext({module:{exports:{}},require:()=>({fetchStockSearch:async(q)=>{calls++;if(fail)throw new Error('upstream');return matchStocks(universe,q);}})});
  vm.runInContext(fs.readFileSync(path.join(root,'api/stock-search.js'),'utf8'),context);
  const run=async(q)=>{
    const result={};const res={setHeader:(k,v)=>{result[k]=v;},status(code){result.status=code;return this;},json(body){result.body=body;return body;}};
    await context.module.exports({query:{q}},res);return result;
  };
  assert.equal((await run('삼성')).body.rows.length,3);
  assert.equal((await run('삼성전기')).body.rows[0].code,'009150');
  assert.equal((await run('a'.repeat(81))).status,400);
  assert.equal(calls,2);
  fail=true;const failed=await run('삼성');assert.equal(failed.status,503);assert.equal(failed.body.ok,false);
});

test('a symbol change during a daily request cannot paint the previous stock into its panel',async()=>{
  const node={innerHTML:'new stock pending'};
  let resolveFetch;
  const response=new Promise(resolve=>{resolveFetch=resolve;});
  const context=vm.createContext({MarketRegime:engine,Date,document:{getElementById:()=>node},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>response});
  vm.runInContext(fs.readFileSync(path.join(root,'market-regime-view.js'),'utf8'),context);
  const inst={key:'SAMSUNG_DAILY',options:{maCompare:true,apiKey:'KR:005930:KOSPI',regimePanelKey:'SAMSUNG_DAILY'}};
  const old=context.MarketRegimeView.update(inst);
  inst.options.apiKey='KR:009150:KOSPI';inst.regimeRevision=1;
  resolveFetch({ok:true,json:async()=>({ok:true,series:[{date:'2026-10-16',close:100}]})});
  await old;
  assert.equal(node.innerHTML,'new stock pending');
});

test('stock legends independently toggle MA5/MA10 and toggle both Bollinger boundaries',()=>{
  const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const calls=[];
  const chips=['5','10','20','60','120','bb'].map(key=>({dataset:{series:key},off:false,classList:{toggle(name,value){this.owner.off=value;}},textContent:`MA${key}`}));
  chips.forEach(chip=>{chip.classList.owner=chip;});
  let click;
  const legend={querySelectorAll:()=>chips,addEventListener:(type,handler)=>{click=handler;}};
  const card={dataset:{},querySelector:(selector)=>selector==='.technical-legend'?legend:null};
  const inst={containerId:'chart',options:{},toggles:{5:true,10:true,20:true,60:true,120:true,bb:true},
    maSeries:Object.fromEntries(['5','10','20','60','120'].map(key=>[key,{applyOptions:opts=>calls.push([key,opts.visible])}])),
    bbSeries:{upper:{applyOptions:opts=>calls.push(['upper',opts.visible])},lower:{applyOptions:opts=>calls.push(['lower',opts.visible])}}
  };
  const context=vm.createContext({lwChartInstances:{stock:inst},document:{getElementById:()=>({closest:()=>card})}});
  vm.runInContext(source.slice(source.indexOf('    function bindStaticChartControls('),source.indexOf('    function renderSummary(')),context);
  context.bindStaticChartControls('stock');
  const choose=(i)=>click({target:{closest:()=>chips[i]}});
  choose(0);assert.deepEqual(calls,[['5',false]]);assert.equal(chips[0].off,true);assert.equal(inst.toggles[10],true);
  choose(0);assert.deepEqual(calls.at(-1),['5',true]);assert.equal(chips[0].off,false);
  choose(1);assert.deepEqual(calls.at(-1),['10',false]);assert.equal(inst.toggles[5],true);
  choose(5);assert.deepEqual(calls.slice(-2),[['upper',false],['lower',false]]);
  choose(5);assert.deepEqual(calls.slice(-2),[['upper',true],['lower',true]]);
});
