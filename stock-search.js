'use strict';

function parseStockKey(key) {
  const match = typeof key === 'string' && key.match(/^KR:(\d{6}):(KOSPI|KOSDAQ)$/);
  return match ? { code: match[1], market: match[2], yahoo: `${match[1]}.${match[2] === 'KOSDAQ' ? 'KQ' : 'KS'}` } : null;
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

async function fetchStockSearch(query) {
  if (!String(query || '').trim()) return [];
  const { fetchMarketUniverse } = require('./dashboard-data');
  const rows = await fetchMarketUniverse();
  if (!rows.length) throw new Error('종목 목록 원천을 확인하지 못했습니다.');
  return matchStocks(rows, query);
}

module.exports = { parseStockKey, matchStocks, fetchStockSearch };
