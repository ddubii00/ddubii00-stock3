'use strict';
const { parseStockKey } = require('./stock-search');
const QUOTE_TTL = 15_000, CHART_TTL = 15_000, HISTORY_TTL = 5 * 60_000;
const ALIASES = {'^KS11':'KOSPI','^KQ11':'KOSDAQ','^IXIC':'NASDAQ','^GSPC':'SP500','KRW=X':'USDKRW','JPY=X':'USDJPY',SAMSUNG:'KR:005930:KOSPI',SKHYNIX:'KR:000660:KOSPI'};
function credentials(env = process.env) {
  return {appKey:env.KIS_APP_KEY || env.KIS_APPKEY || env.KIS_KEY || env.APP_KEY || env.APPKEY || '', appSecret:env.KIS_APP_SECRET || env.KIS_APPSECRET || env.KIS_SECRET || env.APP_SECRET || env.APPSECRET || ''};
}
function config(key, env = process.env) {
  key = ALIASES[key] || key;
  const stock = parseStockKey(key);
  if (stock) return stock.country==='US' ? {key,kind:'us-stock',code:stock.yahoo,market:({NASDAQ:'NAS',NYSE:'NYS',AMEX:'AMS'})[stock.market]} : {key,kind:'stock',code:stock.code,market:'J'};
  if (key==='KOSPI' || key==='KOSDAQ') return {key,kind:'index',code:key==='KOSPI'?'0001':'1001',market:'U'};
  // Overseas master codes may differ by entitlement; server environment overrides are supported.
  const codes = {NASDAQ:['N',env.KIS_NASDAQ_INDEX_CODE || 'COMP'],SP500:['N',env.KIS_SP500_INDEX_CODE || 'SPX'],
    USDKRW:['X',env.KIS_USDKRW_CODE || 'USDKRW'],USDJPY:['X',env.KIS_USDJPY_CODE || 'USDJPY'],
    US10Y:['I',env.KIS_US10Y_CODE],KR3Y:['I',env.KIS_KR3Y_CODE],JP30Y:['I',env.KIS_JP30Y_CODE],GOLD:['S',env.KIS_GOLD_CODE],SOX:['N',env.KIS_SOX_INDEX_CODE]};
  return codes[key]?.[1] ? {key,kind:'overseas',market:codes[key][0],code:codes[key][1]} : null;
}
const number = value => value === null || value === undefined || String(value).trim()==='' ? null :
  (Number.isFinite(Number(String(value).replace(/,/g,''))) ? Number(String(value).replace(/,/g,'')) : null);
const date = value => /^\d{8}$/.test(String(value)) ? String(value).replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3') : null;
const compactDate = value => value.toISOString().slice(0,10).replace(/-/g,'');
function createClient({env = process.env, fetchImpl = (...args)=>fetch(...args), now = ()=>Date.now(), tokenProvider = null} = {}) {
  let token = null, tokenPending = null, tokenBlockedUntil = 0, queue = Promise.resolve();
  const cache = new Map(), pending = new Map(), history = new Map();
  const enabled = () => Boolean(credentials(env).appKey && credentials(env).appSecret);
  async function jsonRequest(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),8000);
    try {
      const response = await fetchImpl(url,{...options,signal:controller.signal});
      if (!response.ok) throw new Error('KIS 원천 응답 오류');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  async function getAccessToken() {
    if (!enabled()) return '';
    if (token && token.expiresAt-now()>60_000) return token.value;
    if (tokenPending) return tokenPending;
    if (now()<tokenBlockedUntil) throw new Error('KIS 인증 재시도 대기');
    tokenPending = (async()=>{
      if (tokenProvider) {
        const supplied=await tokenProvider();
        const value=typeof supplied==='string'?supplied:supplied?.value;
        if (!value) throw new Error('KIS 내부 인증 미제공');
        token={value,expiresAt:Number(supplied?.expiresAt)>now()?Number(supplied.expiresAt):now()+5*60_000};
        return value;
      }
      const {appKey,appSecret}=credentials(env);
      const json=await jsonRequest(`${env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443'}/oauth2/tokenP`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',appkey:appKey,appsecret:appSecret})});
      if (!json.access_token) throw new Error('KIS 인증 미제공');
      token={value:json.access_token,expiresAt:now()+(number(json.expires_in)||3600)*1000};
      return token.value;
    })();
    try { return await tokenPending; }
    catch(error) { tokenBlockedUntil=now()+60_000; throw error; }
    finally { tokenPending=null; }
  }
  async function get(path, trId, params) {
    const value=await getAccessToken();
    if (!value) throw new Error('KIS 환경변수 미설정');
    const task=queue.then(async()=>{
      const {appKey,appSecret}=credentials(env);
      const url=new URL(path,env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443');
      for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
      const json=await jsonRequest(url,{headers:{authorization:`Bearer ${value}`,appkey:appKey,appsecret:appSecret,tr_id:trId,custtype:'P'}});
      if (json.rt_cd!=='0') throw new Error('KIS 시세 조회 실패');
      return json;
    });
    // Serialize this reader's requests, including chart pagination. Never log response bodies or headers.
    queue=task.then(()=>{},()=>{});
    return task;
  }
  async function memo(key, ttl, load) {
    const entry=cache.get(key);
    if (entry && entry.expiresAt>now()) return entry.value;
    if (pending.has(key)) return pending.get(key);
    const promise=(async()=>{
      try { const value=await load(); cache.set(key,{value,expiresAt:now()+ttl}); return value; }
      catch (_) { cache.set(key,{value:null,expiresAt:now()+ttl}); return null; }
      finally { pending.delete(key); }
    })();
    pending.set(key,promise);
    return promise;
  }
  async function quote(input) {
    const c=config(input,env);
    if (!enabled() || !c) return null;
    return memo(`quote:${c.key}`,QUOTE_TTL,async()=>{
      let json;
      if(c.kind==='stock') json=await get('/uapi/domestic-stock/v1/quotations/inquire-price','FHKST01010100',{FID_COND_MRKT_DIV_CODE:c.market,FID_INPUT_ISCD:c.code});
      else if(c.kind==='us-stock') json=await get('/uapi/overseas-price/v1/quotations/price','HHDFS00000300',{AUTH:'',EXCD:c.market,SYMB:c.code});
      else if(c.kind==='index') json=await get('/uapi/domestic-stock/v1/quotations/inquire-index-price','FHPUP02100000',{FID_COND_MRKT_DIV_CODE:'U',FID_INPUT_ISCD:c.code});
      else json=await get('/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice','FHKST03030200',{FID_COND_MRKT_DIV_CODE:c.market,FID_INPUT_ISCD:c.code,FID_HOUR_CLS_CODE:'0',FID_PW_DATA_INCU_YN:'Y'});
      const out=Array.isArray(json.output)?json.output[0]:json.output || (Array.isArray(json.output1)?json.output1[0]:json.output1) || {};
      // NASDAQ means the composite index; never substitute the NASDAQ 100.
      if(c.key==='NASDAQ' && /100|NDX/i.test(out.hts_kor_isnm || '')) throw new Error('지수 종류 불일치');
      const price=number(out.stck_prpr ?? out.bstp_nmix_prpr ?? out.ovrs_nmix_prpr ?? out.last);
      const changePercent=number(out.prdy_ctrt ?? out.bstp_nmix_prdy_ctrt ?? out.rate);
      let previousClose=number(out.stck_prdy_clpr ?? out.prdy_nmix ?? out.ovrs_nmix_prdy_clpr ?? out.base);
      if(previousClose===null && price>0 && changePercent!==null && changePercent!==-100) previousClose=price/(1+changePercent/100);
      if(!(price>0)) throw new Error('시세 미제공');
      return {symbol:input,key:c.key,price,previousClose,changePercent,asOf:date(out.stck_bsop_date || out.bsop_date),queriedAt:new Date(now()).toISOString(),source:'KIS',raw:'KIS'};
    });
  }
  function parseBars(json,c) {
    return (Array.isArray(json.output2)?json.output2:[]).map(row=>{
      const close=number(row.stck_clpr ?? row.bstp_nmix_prpr ?? row.ovrs_nmix_prpr);
      return {date:date(row.stck_bsop_date),close,open:number(row.stck_oprc ?? row.bstp_nmix_oprc ?? row.ovrs_nmix_oprc),
        high:number(row.stck_hgpr ?? row.bstp_nmix_hgpr ?? row.ovrs_nmix_hgpr),low:number(row.stck_lwpr ?? row.bstp_nmix_lwpr ?? row.ovrs_nmix_lwpr),
        volume:number(row.acml_vol),source:'KIS'};
    }).filter(row=>row.date && row.close>0 && [row.open,row.high,row.low].every(v=>v>0));
  }
  async function series(input, interval='1d') {
    const c=config(input,env);
    // US equities use public OHLC history; never send them to the overseas INDEX history API.
    if(!enabled() || !c || c.kind==='us-stock' || !['1d','1wk','1mo'].includes(interval)) return null;
    return memo(`chart:${c.key}:${interval}`,CHART_TTL,async()=>{
      const cacheKey=`${c.key}:${interval}`;
      const saved=history.get(cacheKey);
      const savedValid=saved && saved.expiresAt>now();
      const byDate=new Map((savedValid?saved.rows:[]).map(row=>[row.date,row]));
      const end=new Date(now());let cursor=compactDate(end);
      const start=new Date(end);start.setUTCFullYear(start.getUTCFullYear()-(interval==='1mo'?45:interval==='1wk'?12:4));
      let previousOldest='';
      for(let page=0;page<(savedValid?1:12);page++) {
        const params={FID_COND_MRKT_DIV_CODE:c.market,FID_INPUT_ISCD:c.code,FID_INPUT_DATE_1:compactDate(start),FID_INPUT_DATE_2:cursor,FID_PERIOD_DIV_CODE:({'1d':'D','1wk':'W','1mo':'M'})[interval]};
        if(c.kind==='stock') params.FID_ORG_ADJ_PRC='0';
        const path=c.kind==='stock'?'/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice':c.kind==='index'?'/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice':'/uapi/overseas-price/v1/quotations/inquire-daily-chartprice';
        const trId=c.kind==='stock'?'FHKST03010100':c.kind==='index'?'FHKUP03500100':'FHKST03030100';
        const bars=parseBars(await get(path,trId,params),c);
        if(!bars.length) break;
        for(const row of bars) byDate.set(row.date,row);
        const oldest=bars.map(row=>row.date).sort()[0];
        if(byDate.size>=520 || oldest===previousOldest || oldest.replace(/-/g,'')<=compactDate(start)) break;
        previousOldest=oldest;
        const next=new Date(`${oldest}T00:00:00Z`);next.setUTCDate(next.getUTCDate()-1);cursor=compactDate(next);
      }
      const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-520);
      // A partial KIS response must not displace history needed by MA120/200 and regime rules.
      if(rows.length<Math.min(200,interval==='1d'?200:120)) throw new Error('KIS 차트 이력 부족');
      history.set(cacheKey,{rows,expiresAt:savedValid?saved.expiresAt:now()+HISTORY_TTL});
      return rows;
    });
  }
  async function getTokenInfo(){const value=await getAccessToken();return {value,expiresAt:token?.expiresAt || 0};}
  return { quote, series, getAccessToken, getTokenInfo, enabled };
}
// A gateway-spawned core shares the parent's in-memory token over Node IPC.
// Nothing is written to disk or exposed through an HTTP endpoint.
function parentToken(){
  return new Promise((resolve,reject)=>{
    const requestId=require('node:crypto').randomUUID();
    const finish=(message)=>{
      if(message?.type!=='stock3-kis-auth-result'||message.requestId!==requestId)return;
      cleanup();message.value?resolve({value:message.value,expiresAt:message.expiresAt}):reject(new Error('KIS 내부 인증 실패'));
    };
    const cleanup=()=>{clearTimeout(timer);process.removeListener('message',finish);};
    const timer=setTimeout(()=>{cleanup();reject(new Error('KIS 내부 인증 대기 초과'));},12_000);
    process.on('message',finish);
    process.send({type:'stock3-kis-auth-request',requestId},error=>{if(error){cleanup();reject(new Error('KIS 내부 통신 실패'));}});
  });
}
const client=createClient({tokenProvider:process.env.STOCK3_KIS_FLOW_OWNER==='gateway'&&typeof process.send==='function'&&process.connected?parentToken:null});
module.exports = {...client,createClient,credentials,config,number};
