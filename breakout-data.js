'use strict';

const CACHE_TTL_MS = 3 * 60 * 1000;
let cache = null;
let inFlight = null;

function toNumber(value) {
  const number = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://stock.naver.com/',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
  return response.json();
}

async function fetchMarketRows(market) {
  const params = new URLSearchParams({
    tradeType: 'KRX',
    marketType: market,
    orderType: 'marketSum',
    startIdx: '0',
    pageSize: '2000'
  });
  const rows = await fetchJson(`https://stock.naver.com/api/domestic/market/stock/default?${params}`);
  return Array.isArray(rows) ? rows.map((row) => ({ ...row, market })) : [];
}

async function fetchTradingViewRows() {
  const payload = {
    markets: ['korea'],
    symbols: { query: { types: ['stock'] }, tickers: [] },
    columns: ['name', 'description', 'close', 'change', 'high', 'low', 'High.6M', 'Low.6M', 'High.All', 'Low.All'],
    range: [0, 4000]
  };
  const json = await fetchJson('https://scanner.tradingview.com/korea/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return Array.isArray(json?.data) ? json.data : [];
}

async function fetchHighBreakoutsFresh() {
  const [kospiRows, kosdaqRows, scannerRows] = await Promise.all([
    fetchMarketRows('KOSPI'),
    fetchMarketRows('KOSDAQ'),
    fetchTradingViewRows()
  ]);
  const marketByCode = new Map([...kospiRows, ...kosdaqRows].map((row) => [row.itemcode, row]));
  const rows = [];
  const lowRows = [];
  scannerRows.forEach((scannerRow) => {
    const [code, , scannerClose, scannerChangeRate, scannerHigh, scannerLow, high26Week, low26Week, allTimeHigh, allTimeLow] = scannerRow.d || [];
    const marketRow = marketByCode.get(code);
    if (!marketRow) return;
    const currentPrice = firstPositive(marketRow.nowPrice, scannerClose);
    const todayHigh = firstPositive(marketRow.highPrice, scannerHigh);
    const todayLow = firstPositive(marketRow.lowPrice, scannerLow);
    const week26High = firstPositive(high26Week);
    const week26Low = firstPositive(low26Week);
    const week52High = firstPositive(marketRow.week52HighPrice);
    const week52Low = firstPositive(marketRow.week52LowPrice);
    const lifetimeHigh = firstPositive(allTimeHigh);
    const lifetimeLow = firstPositive(allTimeLow);
    const week26Breakout = todayHigh !== null && week26High !== null && todayHigh >= week26High;
    const week52Breakout = todayHigh !== null && week52High !== null && todayHigh >= week52High;
    const allTimeBreakout = todayHigh !== null && lifetimeHigh !== null && todayHigh >= lifetimeHigh;
    const week26LowBreakout = todayLow !== null && week26Low !== null && todayLow <= week26Low;
    const week52LowBreakout = todayLow !== null && week52Low !== null && todayLow <= week52Low;
    const allTimeLowBreakout = todayLow !== null && lifetimeLow !== null && todayLow <= lifetimeLow;
    const common = {
      market: marketRow.market,
      code,
      name: marketRow.itemname,
      currentPrice,
      change: toNumber(marketRow.prevChangePrice),
      changeRate: toNumber(marketRow.prevChangeRate) ?? toNumber(scannerChangeRate),
      marketStatus: marketRow.marketStatus || ''
    };
    if (week26Breakout || week52Breakout || allTimeBreakout) {
      rows.push({
        ...common,
        todayHigh,
        week26High,
        week52High,
        allTimeHigh: lifetimeHigh,
        week26Breakout,
        week52Breakout,
        allTimeBreakout
      });
    }
    if (week26LowBreakout || week52LowBreakout || allTimeLowBreakout) {
      lowRows.push({
        ...common,
        todayLow,
        week26Low,
        week52Low,
        allTimeLow: lifetimeLow,
        week26LowBreakout,
        week52LowBreakout,
        allTimeLowBreakout
      });
    }
  });

  rows.sort((a, b) => {
    if (a.allTimeBreakout !== b.allTimeBreakout) return Number(b.allTimeBreakout) - Number(a.allTimeBreakout);
    if (a.week52Breakout !== b.week52Breakout) return Number(b.week52Breakout) - Number(a.week52Breakout);
    if (a.market !== b.market) return a.market.localeCompare(b.market);
    return (b.changeRate || 0) - (a.changeRate || 0);
  });
  lowRows.sort((a, b) => {
    if (a.allTimeLowBreakout !== b.allTimeLowBreakout) return Number(b.allTimeLowBreakout) - Number(a.allTimeLowBreakout);
    if (a.week52LowBreakout !== b.week52LowBreakout) return Number(b.week52LowBreakout) - Number(a.week52LowBreakout);
    if (a.market !== b.market) return a.market.localeCompare(b.market);
    return (a.changeRate || 0) - (b.changeRate || 0);
  });
  const statusDates = [...kospiRows, ...kosdaqRows]
    .map((row) => String(row.tradableStatusUpdatedAt || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  return {
    asOf: new Date().toISOString(),
    latestTradeDate: statusDates.sort().pop() || '',
    source: 'Naver Stock KRX + TradingView Korea Scanner',
    criteria: '최근 거래일 고가가 해당 기간 최고가와 같은 종목 · 26주와 역대 최고가는 TradingView, 52주와 시장 구분은 네이버 증권 기준',
    lowCriteria: '최근 거래일 저가가 해당 기간 최저가와 같은 종목 · 26주와 역대 최저가는 TradingView, 52주와 시장 구분은 네이버 증권 기준',
    rows,
    lowRows
  };
}

async function fetchHighBreakouts() {
  if (cache && cache.expiresAt > Date.now()) return cache.payload;
  if (inFlight) return inFlight;
  inFlight = fetchHighBreakoutsFresh()
    .then((payload) => {
      cache = { payload, expiresAt: Date.now() + CACHE_TTL_MS };
      return payload;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { fetchHighBreakouts };
