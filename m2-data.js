'use strict';
// M2 only. Preserve currency units; never substitute Korean M3 or interpolate gaps.
const number=value=>value==null||String(value).trim()===''?null:Number(String(value).replace(/,/g,''));
function observations(rows) {
  const byMonth=new Map();
  for(const row of rows || []){
    const month=String(row.date || '').slice(0,7),value=number(row.value);
    if(/^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&Number.isFinite(value)&&value>0)byMonth.set(month,{date:`${month}-01`,value});
  }
  return [...byMonth.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
function unitDivisor(unit,country) {
  const text=String(unit || '').toLowerCase().replace(/[\s._]/g,'');
  const currency=country==='KR'?'krw':'usd';
  if([currency,country==='KR'?'원':'달러'].includes(text))return 1e12;
  if([`billion${currency}`,`bil${currency}`,country==='KR'?'십억원':'십억달러'].includes(text))return 1000;
  if([`trillion${currency}`,country==='KR'?'조원':'조달러'].includes(text))return 1;
  throw new Error('M2 원자료 단위 확인 필요');
}
function parseKred(html) {
  if(!/KRM2/.test(html)||!/bil\.?\s*KRW/i.test(html))throw new Error('한국 M2 원천/단위 확인 필요');
  const embedded=[...html.matchAll(/\\?"date\\?":\s*\\?"(\d{4}-\d{2}-\d{2})\\?",\s*\\?"value\\?":\s*([\d.]+)/g)].map(m=>({date:m[1],value:Number(m[2])}));
  const plain=value=>value.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').trim();
  const table=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(match=>{
    const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>plain(m[1]));
    return /^\d{4}-\d{2}-\d{2}$/.test(cells[0] || '')&&number(cells[1])>0?[{date:cells[0],value:number(cells[1])}]:[];
  });
  const rows=observations([...embedded,...table]);
  if(!rows.length)throw new Error('한국 M2 공개 관측값 미제공');
  return {rows,divisor:1000,source:'KRED KRM2 · 한국 M2 공개 관측값',limited:embedded.length===0};
}
function payload(input,country,now=new Date()) {
  const raw=observations(input.rows),byMonth=new Map(raw.map(row=>[row.date.slice(0,7),row.value]));
  if(!raw.length)throw new Error('M2 원천 데이터 미제공');
  const series=raw.map(row=>{
    const prior=byMonth.get(`${Number(row.date.slice(0,4))-1}${row.date.slice(4,7)}`);
    return {date:row.date,m2:row.value/input.divisor,m2Yoy:prior>0?(row.value/prior-1)*100:null};
  });
  const latest=series.at(-1).date.slice(0,7),age=(now.getUTCFullYear()-Number(latest.slice(0,4)))*12+now.getUTCMonth()+1-Number(latest.slice(5));
  const label=country==='KR'?'한국':'미국',unit=country==='KR'?'조원':'조달러';
  return {unit:`${unit}/%`,source:input.source,asOf:latest,stale:age>4,lastUpdated:now.toISOString(),
    note:`${label} M2 · ${input.source} · 최신 발표월 ${latest} · ${unit}, YoY(전년동월비) %${input.limited?' · 공개된 최근 관측 구간':''}${age>4?' · 업데이트 지연 확인 필요':''}`,
    series:series.slice(-181)};
}
function createM2({fetchImpl=(...args)=>fetch(...args),now=()=>new Date()}={}) {
  const cache=new Map(),pending=new Map();
  async function request(url){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
    try{const response=await fetchImpl(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:controller.signal});if(!response.ok)throw new Error('M2 원천 응답 오류');return await response.text();}
    finally{clearTimeout(timer);}
  }
  async function rich(country){
    const json=JSON.parse(await request(`https://richcounter.com/api/indices/m2-series?country=${country}&since=2010-01`));
    return {rows:json.series,divisor:unitDivisor(json.unit,country),source:`RichCounter · ${country==='KR'?'한국은행 ECOS':'FRED M2SL'} 기반`};
  }
  async function fred(){
    const csv=await request('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL');
    return {rows:csv.trim().split(/\r?\n/).slice(1).map(line=>{const[date,value]=line.split(',');return{date,value};}),divisor:1000,source:'FRED M2SL'};
  }
  async function series(country){
    if(!['KR','US'].includes(country))throw new Error('지원하지 않는 국가');
    const saved=cache.get(country);
    if(saved && saved.until>now().getTime())return saved.value;
    if(pending.has(country))return pending.get(country);
    const task=(async()=>{
      const loaders=country==='US'?[fred,()=>rich(country)]:[()=>rich(country),async()=>parseKred(await request('https://kred.dev/en/series/KRM2'))];
      for(const load of loaders)try{
        const value=payload(await load(),country,now());
        cache.set(country,{value,until:now().getTime()+60*60_000});return value;
      }catch(_){/* independent public source fallback */}
      if(saved)return {...saved.value,stale:true,note:`${saved.value.note} · 원천 재조회 실패: 마지막 조회 자료`};
      throw new Error(`${country==='KR'?'한국':'미국'} M2 원천 조회 실패 · 새로고침 후에도 같으면 서버의 공개 원천 연결을 확인하세요.`);
    })();
    pending.set(country,task);
    try{return await task;}finally{pending.delete(country);}
  }
  return {series};
}
module.exports={number,observations,unitDivisor,parseKred,payload,createM2,...createM2()};
