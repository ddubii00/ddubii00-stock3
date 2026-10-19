'use strict';
const kis = require('./kis-market-data');
const {parseStockKey} = require('./stock-search');
const SYMBOLS={KOSPI:'^KS11',KOSDAQ:'^KQ11',NASDAQ:'^IXIC',SP500:'^GSPC',USDKRW:'KRW=X',USDJPY:'JPY=X',SOX:'^SOX',GOLD:'GC=F',WTI:'CL=F',DXY:'DX-Y.NYB',US10Y:'^TNX'};
const canonical = key => Object.entries(SYMBOLS).find(([,symbol])=>symbol===key)?.[0] || key;
function createQuotes({kisClient=kis,fetchImpl=(...args)=>fetch(...args),now=()=>Date.now()}={}) {
  const cache=new Map(),pending=new Map();
  async function publicQuote(key) {
    const symbol=parseStockKey(key)?.yahoo || SYMBOLS[key];
    if(!symbol) return null;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`,{headers:{'User-Agent':'Mozilla/5.0'},signal:controller.signal});
      if(!response.ok) return null;
      const json=await response.json();const meta=json?.chart?.result?.[0]?.meta;
      const price=kis.number(meta?.regularMarketPrice);
      if(!(price>0)) return null;
      let previousClose=kis.number(meta.chartPreviousClose ?? meta.previousClose);
      const changePercent=previousClose>0?(price/previousClose-1)*100:kis.number(meta.regularMarketChangePercent);
      if(previousClose===null && changePercent!==null && changePercent!==-100)previousClose=price/(1+changePercent/100);
      return {key,symbol,price,previousClose,changePercent,asOf:meta.regularMarketTime?new Date(meta.regularMarketTime*1000).toISOString():null,
        queriedAt:new Date(now()).toISOString(),source:'Yahoo Finance',raw:'yahoo',delayed:true};
    } finally {clearTimeout(timer);}
  }
  async function quote(input) {
    const key=canonical(input);
    if(!SYMBOLS[key] && !parseStockKey(key)) return null;
    if(cache.get(key)?.expiresAt>now()) return cache.get(key).value;
    if(pending.has(key)) return pending.get(key);
    const request=(async()=>{
      try {
        const primary=await kisClient.quote(key).catch(()=>null);
        const value=primary || await publicQuote(key).catch(()=>null);
        cache.set(key,{value,expiresAt:now()+15_000});
        return value;
      } finally {pending.delete(key);}
    })();
    pending.set(key,request);return request;
  }
  async function snapshot(stocks=[]) {
    const keys=[...new Set(['KOSPI','KOSDAQ','NASDAQ','SP500','USDKRW',...stocks.filter(key=>parseStockKey(key))])];
    const quotes=await Promise.all(keys.map(async(key)=>({key,quote:await quote(key)})));
    return {ok:true,queriedAt:new Date(now()).toISOString(),pollMs:20_000,quotes};
  }
  return {quote,snapshot};
}
module.exports={...createQuotes(),createQuotes,canonical};
