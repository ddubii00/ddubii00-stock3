'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const m2=require('../m2-data'),flow=require('../flow-stats'),gateway=require('../kis-flow-gateway');
const text=body=>({ok:true,text:async()=>body});
const months=Array.from({length:24},(_,i)=>({date:`${2025+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}-01`,value:3000000+i*1000}));
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
test('program daily schema computes whole net money even when the intraday net field is absent',()=>{
  assert.equal(flow.programNetEok({whol_smtn_shnu_tr_pbmn:'1,500',whol_smtn_seln_tr_pbmn:'500'}),10);
  assert.equal(flow.programNetEok({arbt_smtn_ntby_tr_pbmn:'-100',nabt_smtn_ntby_tr_pbmn:'350'}),2.5);
  assert.equal(flow.programNetEok({whol_smtn_ntby_tr_pbmn:'0',whol_smtn_shnu_tr_pbmn:'1500',whol_smtn_seln_tr_pbmn:'500'}),0);
  for(const row of [{},{whol_smtn_shnu_tr_pbmn:'100'},{arbt_smtn_ntby_tr_pbmn:'100'},{whol_smtn_ntby_tr_pbmn:''}])assert.equal(flow.programNetEok(row),null);
  const rows=gateway.parseProgramDailyRows({output:[{stck_bsop_date:'20261019',whol_smtn_shnu_tr_pbmn:'2500',whol_smtn_seln_tr_pbmn:'3000'}]});
  assert.deepEqual(rows,[{date:'2026-10-19',value:-5}]);
});
test('M2 normalizes known currencies/units only, deduplicates monthly observations and preserves missing YoY',()=>{
  assert.equal(m2.unitDivisor('KRW','KR'),1e12);assert.equal(m2.unitDivisor('bil. KRW','KR'),1000);
  assert.equal(m2.unitDivisor('조달러','US'),1);assert.throws(()=>m2.unitDivisor('index','KR'));
  const out=m2.payload({rows:[...months,{date:'bad',value:5},{date:'2026-09-01',value:null}],divisor:1000,source:'test'},'KR',new Date('2027-01-01'));
  assert.equal(out.series.length,24);assert.equal(out.series[0].m2Yoy,null);assert.equal(out.series[12].m2Yoy,(3012000/3000000-1)*100);
  assert.equal(out.series[0].m2,3000);assert.equal(out.asOf,'2026-12');
});
test('Korean M2 uses the alternate public source with explicit units and limited-history label',async()=>{
  const table=`<h1>KRM2</h1><p>Value (bil. KRW)</p><table>${months.map(row=>`<tr><td><span>${row.date}</span></td><td>${row.value.toLocaleString('en-US')}</td></tr>`).join('')}</table>`;
  const urls=[];const client=m2.createM2({now:()=>new Date('2027-01-01'),fetchImpl:async url=>{
    urls.push(url);if(url.includes('richcounter'))return{ok:false};return text(table);
  }});
  const out=await client.series('KR');assert.equal(out.series[0].m2,3000);assert.match(out.note,/KRED/);assert.match(out.note,/최근 관측 구간/);
  assert.equal(urls.length,2);await client.series('KR');assert.equal(urls.length,2);
  assert.ok(urls.every(url=>!url.includes('M3')));
});
test('US M2 fetches FRED directly and old cached data is labeled when all refresh sources fail',async()=>{
  let clock=new Date('2026-10-20'),fail=false,calls=0;
  const client=m2.createM2({now:()=>clock,fetchImpl:async url=>{
    calls++;if(fail)throw new Error('offline');assert.match(url,/fredgraph.csv\?id=M2SL$/);
    return text('observation_date,M2SL\n2025-08-01,22000\n2026-08-01,23000\n2026-09-01,.');
  }});
  const out=await client.series('US');assert.equal(out.series.at(-1).m2,23);assert.equal(out.series.length,2);
  assert.equal(out.series[0].m2Yoy,null);assert.equal(out.stale,false);
  clock=new Date('2026-10-21');fail=true;
  const stale=await client.series('US');assert.equal(stale.stale,true);assert.match(stale.note,/最後|마지막 조회 자료/);assert.equal(calls,3);
  await assert.rejects(m2.createM2({fetchImpl:async()=>{throw new Error('offline');}}).series('KR'),/한국 M2 원천 조회 실패/);
});
test('M2 chart remains visible when year-over-year observations are entirely missing',async()=>{
  const chart={clientWidth:600,clientHeight:270,innerHTML:'',querySelector:()=>null};const note={};
  const context=vm.createContext({document:{getElementById:id=>id==='chart'?chart:note},fetchJsonWithRetry:async()=>({ok:true,unit:'조원/%',note:'최근 발표',series:[{date:'2026-08-01',m2:4000,m2Yoy:null},{date:'2026-09-01',m2:4100,m2Yoy:null}]}),URLSearchParams,console});
  vm.runInContext(html.slice(html.indexOf('    async function renderExtraChart('),html.indexOf('    function bindInvestorDaysInput(')),context);
  await context.renderExtraChart('chart','note','m2-trend',[{key:'m2',label:'M2',unit:'조원',color:'blue'},{key:'m2Yoy',axis:'right',label:'YoY',unit:'%',color:'red'}],{dualAxis:true,showLastValues:true});
  assert.match(chart.innerHTML,/<svg/);assert.match(chart.innerHTML,/4,100/);assert.doesNotMatch(chart.innerHTML,/NaN/);assert.match(chart.innerHTML,/>-%</);
});
test('a separate contract highlight never fills a spot-fallback history window',()=>{
  const out=flow.mergeFlowStats({futuresMode:'spot-fallback',futuresUnit:'억원',futuresArray:[947,null,null,null,null]},
    {futuresLatest:{value:-3500,unit:'계약',asOf:'2026-10-19',source:'KIS'},futuresArray:[-3500,-7000],futuresCoverageDays:2});
  assert.equal(out.futuresArray[0],947);assert.equal(out.futuresArray[1],null);assert.equal(out.futuresLatest.value,-3500);
});
test('public quotes select regular-session prices and ignore pre/post-market fields after close',async()=>{
  const quotes=require('../market-quotes').createQuotes({kisClient:{quote:async()=>null},now:()=>Date.parse('2026-10-20T23:00:00Z'),fetchImpl:async()=>({ok:true,json:async()=>({chart:{result:[{meta:{regularMarketPrice:250.12,chartPreviousClose:249,postMarketPrice:260,preMarketPrice:240,regularMarketTime:Date.parse('2026-10-20T20:00:00Z')/1000}}]}})})});
  const value=await quotes.quote('US:AAPL:NASDAQ');assert.equal(value.price,250.12);assert.equal(value.asOf,'2026-10-20T20:00:00.000Z');
});
