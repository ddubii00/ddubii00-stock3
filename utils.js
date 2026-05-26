// utils.js - shared functions for Vercel API routes
const quoteMap = {
  '^IXIC': '^ndq',
  '^GSPC': '^spx',
  '^KS11': '^kospi',
  '^KQ11': '^kosdaq'
};

const chartMap = {
  US10Y: '10us.b',
  US2Y: '2us.b',
  USDKRW: 'usdkrw',
  VIX: '^vix',
  SOX: '^sox',
  WTI: 'cl.f',
  DXY: 'dx.f',
  NASDAQ: '^ndq',
  SP500: '^spx',
  KOSPI: '^kospi',
  KOSDAQ: '^kosdaq',
  GOLD: 'GC=F'
};

const quoteCache = new Map();

const quoteFallbackKeyMap = {
  '^IXIC': 'NASDAQ',
  '^GSPC': 'SP500',
  '^KS11': 'KOSPI',
  '^KQ11': 'KOSDAQ'
};

async function fallbackQuoteFromSeries(symbol) {
  const key = quoteFallbackKeyMap[symbol];
  if (!key) return null;

  const rows = await fetchChartSeries(key);
  if (!rows || rows.length < 2) return null;

  const last = rows[rows.length - 1].close;
  const prev = rows[rows.length - 2].close;
  const asOf = rows[rows.length - 1].date;

  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;

  return {
    symbol,
    price: last,
    changePercent: ((last - prev) / prev) * 100,
    asOf,
    raw: 'fallback-from-series'
  };
}

async function fetchStooq(symbol) {
  // Yahoo for major indices
  if (['^KS11', '^KQ11', '^IXIC', '^GSPC'].includes(symbol)) {
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=2m`;
      const yr = await fetch(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const yj = await yr.json();
      const result = yj?.chart?.result?.[0];

      if (result && result.meta && typeof result.meta.regularMarketPrice === 'number') {
        const price = result.meta.regularMarketPrice;
        const prevClose = result.meta.chartPreviousClose;

        let change = result.meta.regularMarketChangePercent ?? 0;
        if (typeof prevClose === 'number' && prevClose !== 0) {
          change = ((price - prevClose) / prevClose) * 100;
        }

        const asOf = new Date().toISOString();
        const out = { symbol, price, changePercent: change, asOf, raw: 'yahoo' };
        quoteCache.set(symbol, out);
        return out;
      }
    } catch (_) {
      // fall back
    }
  }

  const stooq = quoteMap[symbol];
  if (!stooq) return null;

  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&e=csv`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const t = (await r.text()).trim();
  const parts = t.split(',');

  if (parts.length < 7) return null;

  const close = Number(parts[6]);
  const open = Number(parts[3]);

  let changePercent = null;
  const chartKey = quoteFallbackKeyMap[symbol];

  if (chartKey) {
    const series = await fetchChartSeries(chartKey);
    if (series && series.length >= 2) {
      const lastClose = series[series.length - 1].close;
      const prevClose = series[series.length - 2].close;

      if (Number.isFinite(lastClose) && Number.isFinite(prevClose) && prevClose !== 0) {
        changePercent = ((lastClose - prevClose) / prevClose) * 100;
      }
    }
  }

  if (changePercent === null) {
    if (Number.isFinite(close) && Number.isFinite(open) && open !== 0) {
      changePercent = ((close - open) / open) * 100;
    } else {
      changePercent = 0;
    }
  }

  const out = { symbol, price: close, changePercent, asOf: parts[1], raw: t };
  quoteCache.set(symbol, out);
  return out;
}

async function yahooSimpleSeries(encodedSym, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSym}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await r.json();

  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];

  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close) || close <= 0) continue;

    rows.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      close
    });
  }

  return rows;
}

async function fetchChartSeries(key, interval = '1d') {
  // US10Y
  if (key === 'US10Y') {
    const rows = await yahooSimpleSeries('%5ETNX');
    return rows.length ? rows.slice(-120) : null;
  }

  // US2Y
  if (key === 'US2Y') {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    const lines = text.trim().split('\n');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');

      if (parts.length === 2) {
        const close = Number(parts[1]);

        if (Number.isFinite(close) && close > 0) {
          rows.push({ date: parts[0], close });
        }
      }
    }

    // Supplement with Treasury.gov data for the latest missing days.
    try {
      const year = new Date().getFullYear();
      const tUrl = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
      const tr = await fetch(tUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const tXml = await tr.text();

      const dates = [...tXml.matchAll(/<d:NEW_DATE[^>]*>([^<T]+)T/g)].map(m => m[1]);
      const yields = [...tXml.matchAll(/<d:BC_2YEAR[^>]*>([^<]+)<\/d:BC_2YEAR>/g)].map(m => Number(m[1]));

      const lastFredDate = rows.length > 0 ? rows[rows.length - 1].date : '';
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] > lastFredDate && Number.isFinite(yields[i]) && yields[i] > 0) {
          rows.push({ date: dates[i], close: yields[i] });
        }
      }
    } catch (_) {
      // Keep FRED rows if Treasury.gov supplement fails.
    }

    return rows.length ? rows.slice(-120) : null;
  }

  // USD/KRW
  if (key === 'USDKRW') {
    const rows = await yahooSimpleSeries('KRW%3DX');
    return rows.length ? rows.slice(-120) : null;
  }

  // Yahoo Finance simple close series.
  const yahooMap = {
    VIX: '%5EVIX',
    SOX: '%5ESOX',
    WTI: 'CL%3DF',
    DXY: 'DX-Y.NYB',
    GOLD: 'GC%3DF'
  };

  if (yahooMap[key]) {
    const rows = await yahooSimpleSeries(yahooMap[key]);
    return rows.length ? rows.slice(-120) : null;
  }

  // Yahoo symbols for indices, OHLC candle data.
  const yahooSymbols = {
    KOSPI: '%5EKS11',
    KOSDAQ: '%5EKQ11',
    NASDAQ: '%5EIXIC',
    SP500: '%5EGSPC'
  };

  if (yahooSymbols[key]) {
    const sym = yahooSymbols[key];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=10y&interval=${interval}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();

    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const quotes = result?.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];

    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      const open = Number(opens[i]);
      const high = Number(highs[i]);
      const low = Number(lows[i]);
      const close = Number(closes[i]);

      if (!Number.isFinite(close) || close <= 0) continue;

      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, open, high, low, close });
    }

    return rows.length ? rows.slice(-1500) : null;
  }

  // Stooq fallback.
  const stooq = chartMap[key];
  if (!stooq) return null;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const csv = (await r.text()).trim();
  const lines = csv.split('\n');

  if (lines.length < 3) return null;

  const rows = lines
    .slice(-120)
    .map(line => {
      const p = line.split(',');
      return { date: p[0], close: Number(p[4]) };
    })
    .filter(x => Number.isFinite(x.close));

  return rows.length ? rows : null;
}

module.exports = {
  fetchStooq,
  fetchChartSeries,
  fallbackQuoteFromSeries
};
