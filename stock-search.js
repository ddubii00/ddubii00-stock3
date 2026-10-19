'use strict';

function parseStockKey(key) {
  const match = typeof key === 'string' && key.match(/^KR:(\d{6}):(KOSPI|KOSDAQ)$/);
  if (match) return { country:'KR', code:match[1], market:match[2], yahoo:`${match[1]}.${match[2] === 'KOSDAQ' ? 'KQ' : 'KS'}` };
  const us = typeof key === 'string' && key.match(/^US:([A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?):(NASDAQ|NYSE|AMEX)$/);
  return us ? {country:'US',code:us[1],market:us[2],yahoo:us[1].replace('.', '-')} : null;
}

function matchStocks(rows, query, limit = 20) {
  const q = String(query || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase().slice(0, 80);
  if (!q) return [];
  return rows.filter((row) => /^\d{6}$/.test(row.code) && ['KOSPI','KOSDAQ'].includes(row.marketType) && typeof row.name === 'string')
    .map((row) => {
      const name = row.name.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
      const rank = row.code === q || name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) || row.code.startsWith(q) ? 2 : 3;
      return { row, rank };
    }).filter((item) => item.rank < 3).sort((a,b) => a.rank - b.rank || (Number(b.row.marketCap) || 0) - (Number(a.row.marketCap) || 0))
    .slice(0, Math.max(1, Math.min(20, limit))).map(({row}) => ({code:row.code, name:row.name, market:row.marketType, key:`KR:${row.code}:${row.marketType}`}));
}

// Korean aliases help find common US companies; exchange/symbol are verified by the search source.
const US_ALIASES = {애플:'AAPL',엔비디아:'NVDA',테슬라:'TSLA',마이크로소프트:'MSFT',아마존:'AMZN',구글:'GOOGL',알파벳:'GOOGL',메타:'META',팔란티어:'PLTR',브로드컴:'AVGO',버크셔:'BRK-B',코카콜라:'KO'};
function usMatches(quotes) {
  const exchanges = {NMS:'NASDAQ',NGM:'NASDAQ',NCM:'NASDAQ',NASDAQ:'NASDAQ',NYQ:'NYSE',NYSE:'NYSE',ASE:'AMEX',PCX:'AMEX',AMEX:'AMEX'};
  return (Array.isArray(quotes)?quotes:[]).flatMap(row=>{
    const market=exchanges[row.exchange], code=String(row.symbol || '').toUpperCase();
    const name=String(row.shortname || row.longname || code).slice(0,80),key=`US:${code}:${market}`;
    if (!['EQUITY','ETF'].includes(row.quoteType) || !parseStockKey(key) || !name) return [];
    return [{name,code,market,key}];
  });
}
function createSearch({fetchImpl=(...args)=>fetch(...args), universe=()=>require('./dashboard-data').fetchMarketUniverse()}={}) {
  const cache=new Map();
  return async function fetchStockSearch(query) {
    const q=String(query || '').trim().slice(0,80);
    if (!q) return [];
    const usQuery=US_ALIASES[q] || q;
    const searchUS=async()=>{
      if (cache.get(usQuery)?.until>Date.now()) return cache.get(usQuery).rows;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
      try {
        const response=await fetchImpl(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(usQuery)}&quotesCount=20&newsCount=0&lang=en-US&region=US`,{headers:{'User-Agent':'Mozilla/5.0'},signal:controller.signal});
        if (!response.ok) throw new Error('미국 종목 검색 실패');
        const rows=usMatches((await response.json()).quotes);
        cache.set(usQuery,{rows,until:Date.now()+60_000});return rows;
      } finally {clearTimeout(timer);}
    };
    const requests=[universe().then(rows=>{if(!rows.length)throw new Error('국내 종목 원천 미제공');return matchStocks(rows,q);})];
    if (/^[\x20-\x7e]+$/.test(q) || US_ALIASES[q]) requests.push(searchUS());
    const results=await Promise.allSettled(requests);
    if (results.every(result=>result.status==='rejected')) throw new Error('종목 검색 원천 미제공');
    const rows=results.flatMap(result=>result.status==='fulfilled'?result.value:[]);
    return [...new Map(rows.map(row=>[row.key,row])).values()].slice(0,20);
  };
}
module.exports = { parseStockKey, matchStocks, usMatches, createSearch, fetchStockSearch:createSearch() };
