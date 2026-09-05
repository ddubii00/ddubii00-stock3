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

function maxPositive(rows, field) {
  const values = rows
    .map((row) => toNumber(row[field]))
    .filter((value) => value !== null && value > 0);
  return values.length ? Math.max(...values) : null;
}

function minPositive(rows, field) {
  const values = rows
    .map((row) => toNumber(row[field]))
    .filter((value) => value !== null && value > 0);
  return values.length ? Math.min(...values) : null;
}

function periodReturn(rows, days) {
  const closes = rows.filter((row) => row.close !== null && row.close > 0);
  if (closes.length <= days) return null;
  const latest = closes[closes.length - 1];
  const base = closes[closes.length - 1 - days];
  if (!base?.close) return null;
  return {
    value: ((latest.close - base.close) / base.close) * 100,
    fromDate: base.date,
    toDate: latest.date
  };
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
    columns: ['name', 'description', 'close', 'change', 'high', 'low', 'High.1M', 'Low.1M', 'High.6M', 'Low.6M', 'High.All', 'Low.All'],
    range: [0, 4000]
  };
  const json = await fetchJson('https://scanner.tradingview.com/korea/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return Array.isArray(json?.data) ? json.data : [];
}

function naverHistoryRows(json) {
  return Array.isArray(json)
    ? json.map((row) => ({
      date: String(row.localDate || ''),
      high: toNumber(row.highPrice),
      low: toNumber(row.lowPrice),
      close: toNumber(row.closePrice)
    })).filter((row) => /^\d{8}$/.test(row.date) && row.high !== null && row.low !== null && row.close !== null)
    : [];
}

function historyStats(rows) {
  if (!rows.length) return null;
  return {
    high20: maxPositive(rows.slice(-20), 'high'),
    low20: minPositive(rows.slice(-20), 'low'),
    high26Week: maxPositive(rows.slice(-130), 'high'),
    low26Week: minPositive(rows.slice(-130), 'low'),
    high52Week: maxPositive(rows.slice(-260), 'high'),
    low52Week: minPositive(rows.slice(-260), 'low'),
    allTimeHigh: maxPositive(rows, 'high'),
    allTimeLow: minPositive(rows, 'low'),
    return20: periodReturn(rows, 20),
    return60: periodReturn(rows, 60)
  };
}

function naverDateRange() {
  const end = new Date();
  const yyyy = end.getFullYear();
  const mm = String(end.getMonth() + 1).padStart(2, '0');
  const dd = String(end.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}0000`;
}

async function fetchNaverHistoryStats(code) {
  const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=199001010000&endDateTime=${naverDateRange()}`;
  const json = await fetchJson(url);
  return historyStats(naverHistoryRows(json));
}

async function fetchNaverIndexStats(market) {
  const indexCode = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const url = `https://api.stock.naver.com/chart/domestic/index/${indexCode}/day?startDateTime=199001010000&endDateTime=${naverDateRange()}`;
  const json = await fetchJson(url);
  return historyStats(naverHistoryRows(json));
}

function relativeReturn(stockReturn, indexReturn, indexLabel) {
  if (!Number.isFinite(stockReturn?.value) || !Number.isFinite(indexReturn?.value)) return null;
  return {
    value: stockReturn.value - indexReturn.value,
    stockReturn: stockReturn.value,
    indexReturn: indexReturn.value,
    indexLabel,
    fromDate: stockReturn.fromDate,
    toDate: stockReturn.toDate
  };
}

async function fetchIndexStatsSafely(market) {
  try {
    return await fetchNaverIndexStats(market);
  } catch (_) {
    return null;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchHighBreakoutsFresh() {
  const [kospiRows, kosdaqRows, scannerRows, kospiIndexStats, kosdaqIndexStats] = await Promise.all([
    fetchMarketRows('KOSPI'),
    fetchMarketRows('KOSDAQ'),
    fetchTradingViewRows(),
    fetchIndexStatsSafely('KOSPI'),
    fetchIndexStatsSafely('KOSDAQ')
  ]);
  const indexStatsByMarket = {
    KOSPI: kospiIndexStats,
    KOSDAQ: kosdaqIndexStats
  };
  const marketByCode = new Map([...kospiRows, ...kosdaqRows].map((row) => [row.itemcode, row]));
  const candidates = [];
  scannerRows.forEach((scannerRow) => {
    const [code, , scannerClose, scannerChangeRate, scannerHigh, scannerLow, high20Day, low20Day, high26Week, low26Week, allTimeHigh, allTimeLow] = scannerRow.d || [];
    const marketRow = marketByCode.get(code);
    if (!marketRow) return;
    const currentPrice = firstPositive(marketRow.nowPrice, scannerClose);
    const todayHigh = firstPositive(marketRow.highPrice, scannerHigh);
    const todayLow = firstPositive(marketRow.lowPrice, scannerLow);
    const day20High = firstPositive(high20Day);
    const day20Low = firstPositive(low20Day);
    const week26High = firstPositive(high26Week);
    const week26Low = firstPositive(low26Week);
    const week52High = firstPositive(marketRow.week52HighPrice);
    const week52Low = firstPositive(marketRow.week52LowPrice);
    const lifetimeHigh = firstPositive(allTimeHigh);
    const lifetimeLow = firstPositive(allTimeLow);
    const day20Breakout = todayHigh !== null && day20High !== null && todayHigh >= day20High;
    const week26Breakout = todayHigh !== null && week26High !== null && todayHigh >= week26High;
    const week52Breakout = todayHigh !== null && week52High !== null && todayHigh >= week52High;
    const allTimeBreakout = todayHigh !== null && lifetimeHigh !== null && todayHigh >= lifetimeHigh;
    const day20LowBreakout = todayLow !== null && day20Low !== null && todayLow <= day20Low;
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
    if (day20Breakout || week26Breakout || week52Breakout || allTimeBreakout || day20LowBreakout || week26LowBreakout || week52LowBreakout || allTimeLowBreakout) {
      candidates.push({
        ...common,
        todayHigh,
        todayLow,
        day20High,
        day20Low,
        week26High,
        week26Low,
        week52High,
        week52Low,
        allTimeHigh: lifetimeHigh,
        allTimeLow: lifetimeLow,
        needsHistoryCheck: allTimeBreakout || allTimeLowBreakout
      });
    }
  });

  const verified = await mapLimit(candidates, 8, async (candidate) => {
    let history = null;
    try {
      history = await fetchNaverHistoryStats(candidate.code);
    } catch (_) {
      history = null;
    }
    const indexStats = indexStatsByMarket[candidate.market];
    const day20High = candidate.day20High;
    const day20Low = candidate.day20Low;
    const week26High = candidate.week26High;
    const week26Low = candidate.week26Low;
    const week52High = candidate.week52High;
    const week52Low = candidate.week52Low;
    const allTimeHigh = firstPositive(history?.allTimeHigh, candidate.allTimeHigh);
    const allTimeLow = firstPositive(history?.allTimeLow, candidate.allTimeLow);
    return {
      ...candidate,
      day20High,
      day20Low,
      week26High,
      week26Low,
      week52High,
      week52Low,
      allTimeHigh,
      allTimeLow,
      relativeReturns: {
        day20: relativeReturn(history?.return20, indexStats?.return20, candidate.market),
        day60: relativeReturn(history?.return60, indexStats?.return60, candidate.market)
      },
      day20Breakout: candidate.todayHigh !== null && day20High !== null && candidate.todayHigh >= day20High,
      week26Breakout: candidate.todayHigh !== null && week26High !== null && candidate.todayHigh >= week26High,
      week52Breakout: candidate.todayHigh !== null && week52High !== null && candidate.todayHigh >= week52High,
      allTimeBreakout: candidate.todayHigh !== null && allTimeHigh !== null && candidate.todayHigh >= allTimeHigh,
      day20LowBreakout: candidate.todayLow !== null && day20Low !== null && candidate.todayLow <= day20Low,
      week26LowBreakout: candidate.todayLow !== null && week26Low !== null && candidate.todayLow <= week26Low,
      week52LowBreakout: candidate.todayLow !== null && week52Low !== null && candidate.todayLow <= week52Low,
      allTimeLowBreakout: candidate.todayLow !== null && allTimeLow !== null && candidate.todayLow <= allTimeLow
    };
  });
  const rows = verified.filter((row) => row.day20Breakout || row.week26Breakout || row.week52Breakout || row.allTimeBreakout);
  const lowRows = verified.filter((row) => row.day20LowBreakout || row.week26LowBreakout || row.week52LowBreakout || row.allTimeLowBreakout);

  rows.sort((a, b) => {
    if (a.allTimeBreakout !== b.allTimeBreakout) return Number(b.allTimeBreakout) - Number(a.allTimeBreakout);
    if (a.week52Breakout !== b.week52Breakout) return Number(b.week52Breakout) - Number(a.week52Breakout);
    if (a.week26Breakout !== b.week26Breakout) return Number(b.week26Breakout) - Number(a.week26Breakout);
    if (a.day20Breakout !== b.day20Breakout) return Number(b.day20Breakout) - Number(a.day20Breakout);
    if (a.market !== b.market) return a.market.localeCompare(b.market);
    return (b.changeRate || 0) - (a.changeRate || 0);
  });
  lowRows.sort((a, b) => {
    if (a.allTimeLowBreakout !== b.allTimeLowBreakout) return Number(b.allTimeLowBreakout) - Number(a.allTimeLowBreakout);
    if (a.week52LowBreakout !== b.week52LowBreakout) return Number(b.week52LowBreakout) - Number(a.week52LowBreakout);
    if (a.week26LowBreakout !== b.week26LowBreakout) return Number(b.week26LowBreakout) - Number(a.week26LowBreakout);
    if (a.day20LowBreakout !== b.day20LowBreakout) return Number(b.day20LowBreakout) - Number(a.day20LowBreakout);
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
    criteria: '최근 거래일 고가가 해당 기간 최고가와 같은 종목 · 종목별 20일/60일 수익률에서 해당 시장지수 수익률을 뺀 상대수익률 표시',
    lowCriteria: '최근 거래일 저가가 해당 기간 최저가와 같은 종목 · 종목별 20일/60일 수익률에서 해당 시장지수 수익률을 뺀 상대수익률 표시',
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
