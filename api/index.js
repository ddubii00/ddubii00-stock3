'use strict';
// api/index.js  ─  Vercel serverless: /api/chart, /api/quote, /api/stats 전부 처리

const quoteMap = {
  '^IXIC': '^ndq',
  '^GSPC': '^spx',
  '^KS11': '^kospi',
  '^KQ11': '^kosdaq',
};
const chartMap = {
  US10Y: '10us.b', US2Y: '2us.b', USDKRW: 'usdkrw',
  VIX: '^vix', SOX: '^sox', WTI: 'cl.f', DXY: 'dx.f',
  NASDAQ: '^ndq', SP500: '^spx', KOSPI: '^kospi', KOSDAQ: '^kosdaq', GOLD: 'GC=F',
};
const quoteFallbackKeyMap = {
  '^IXIC': 'NASDAQ', '^GSPC': 'SP500', '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ',
};
const quoteCache = new Map();

// ── fetchStooq ──────────────────────────────────────────────────────────────
function parseKoreanNumber(value) {
  return Number(String(value ?? '').replace(/,/g, ''));
}

async function fetchNaverIndexQuote(symbol) {
  const naverCode = symbol === '^KS11' ? 'KOSPI' : symbol === '^KQ11' ? 'KOSDAQ' : null;
  if (!naverCode) return null;
  const url = `https://m.stock.naver.com/api/index/${naverCode}/price?pageSize=1&page=1`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const price = parseKoreanNumber(row.closePrice);
  const changePercent = parseKoreanNumber(row.fluctuationsRatio);
  if (!Number.isFinite(price) || !Number.isFinite(changePercent)) return null;
  const out = {
    symbol,
    price,
    changePercent,
    asOf: row.localTradedAt,
    raw: 'naver-index'
  };
  quoteCache.set(symbol, out);
  return out;
}

async function fetchStooq(symbol) {
  if (symbol === '^KS11' || symbol === '^KQ11') {
    const naverQuote = await fetchNaverIndexQuote(symbol);
    if (naverQuote) return naverQuote;
  }

  if (['^KS11', '^KQ11', '^IXIC', '^GSPC'].includes(symbol)) {
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=2m`;
      const yr = await fetch(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const yj = await yr.json();
      const result = yj?.chart?.result?.[0];
      if (result?.meta && typeof result.meta.regularMarketPrice === 'number') {
        const price = result.meta.regularMarketPrice;
        const prevClose = result.meta.chartPreviousClose;
        let change = result.meta.regularMarketChangePercent ?? 0;
        if (typeof prevClose === 'number' && prevClose !== 0) {
          change = ((price - prevClose) / prevClose) * 100;
        }
        const out = { symbol, price, changePercent: change, asOf: new Date().toISOString(), raw: 'yahoo' };
        quoteCache.set(symbol, out);
        return out;
      }
    } catch (_) {}
  }

  const stooq = quoteMap[symbol];
  if (!stooq) return null;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&e=csv`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const t = (await r.text()).trim();
  const parts = t.split(',');
  if (parts.length < 7) return null;
  const close = Number(parts[6]);
  const open  = Number(parts[3]);

  let changePercent = null;
  const chartKey = quoteFallbackKeyMap[symbol];
  if (chartKey) {
    const series = await fetchChartSeries(chartKey);
    if (series && series.length >= 2) {
      const lc = series[series.length - 1].close;
      const pc = series[series.length - 2].close;
      if (Number.isFinite(lc) && Number.isFinite(pc) && pc !== 0)
        changePercent = ((lc - pc) / pc) * 100;
    }
  }
  if (changePercent === null)
    changePercent = (Number.isFinite(close) && Number.isFinite(open) && open !== 0)
      ? ((close - open) / open) * 100 : 0;

  const out = { symbol, price: close, changePercent, asOf: parts[1], raw: t };
  quoteCache.set(symbol, out);
  return out;
}

// ── fetchChartSeries ────────────────────────────────────────────────────────
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
    rows.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close });
  }
  return rows;
}

async function yahooOHLCSeries(encodedSym, interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSym}?range=10y&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q  = result?.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number((q.close || [])[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    rows.push({
      date:  new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open:  Number((q.open  || [])[i]),
      high:  Number((q.high  || [])[i]),
      low:   Number((q.low   || [])[i]),
      close,
    });
  }
  return rows;
}

async function fetchChartSeries(key, interval = '1d') {
  // 미국 국채 10년
  if (key === 'US10Y') {
    const rows = await yahooSimpleSeries('%5ETNX');
    return rows.length ? rows.slice(-120) : null;
  }
  // 미국 국채 2년 (FRED + Treasury.gov 보완)
  if (key === 'US2Y') {
    const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    const rows = [];
    for (const line of text.trim().split('\n').slice(1)) {
      const [date, val] = line.split(',');
      const close = Number(val);
      if (Number.isFinite(close) && close > 0) rows.push({ date, close });
    }
    try {
      const year = new Date().getFullYear();
      const tr = await fetch(
        `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const xml = await tr.text();
      const dates  = [...xml.matchAll(/<d:NEW_DATE[^>]*>([^<T]+)T/g)].map(m => m[1]);
      const yields = [...xml.matchAll(/<d:BC_2YEAR[^>]*>([^<]+)<\/d:BC_2YEAR>/g)].map(m => Number(m[1]));
      const lastDate = rows.length ? rows[rows.length - 1].date : '';
      for (let i = 0; i < dates.length; i++)
        if (dates[i] > lastDate && Number.isFinite(yields[i]) && yields[i] > 0)
          rows.push({ date: dates[i], close: yields[i] });
    } catch (_) {}
    return rows.length ? rows.slice(-120) : null;
  }
  // Yahoo Finance 단순 close 시리즈
  const simpleMap = {
    USDKRW: 'KRW%3DX', VIX: '%5EVIX', SOX: '%5ESOX',
    WTI: 'CL%3DF', DXY: 'DX-Y.NYB', GOLD: 'GC%3DF',
  };
  if (simpleMap[key]) {
    const rows = await yahooSimpleSeries(simpleMap[key]);
    return rows.length ? rows.slice(-120) : null;
  }
  // Yahoo Finance OHLC (캔들차트용)
  const ohlcMap = {
    KOSPI: '%5EKS11', KOSDAQ: '%5EKQ11', NASDAQ: '%5EIXIC', SP500: '%5EGSPC',
  };
  if (ohlcMap[key]) {
    const rows = await yahooOHLCSeries(ohlcMap[key], interval);
    return rows.length ? rows.slice(-1500) : null;
  }
  // Stooq CSV fallback
  const stooq = chartMap[key];
  if (!stooq) return null;
  const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const csv = (await r.text()).trim();
  const lines = csv.split('\n');
  if (lines.length < 3) return null;
  const rows = lines.slice(-120).map(line => {
    const p = line.split(',');
    return { date: p[0], close: Number(p[4]) };
  }).filter(x => Number.isFinite(x.close));
  return rows.length ? rows : null;
}

// ── 공통 응답 헬퍼 ────────────────────────────────────────────────────────
function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).end(JSON.stringify(body));
}

// ── Vercel 핸들러 ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Vercel rewrite 시 req.url 이 /api/index 로 바뀌므로 원래 경로를 헤더에서 읽음
  const rawUrl = req.headers['x-vercel-rewritten-for'] || req.url || '/';
  const u = new URL(rawUrl.startsWith('http') ? rawUrl : `http://localhost${rawUrl}`);
  const pathname = u.pathname.replace(/\/$/, '');

  // /api/quote
  if (pathname === '/api/quote') {
    const symbol = u.searchParams.get('symbol') || '';
    if (!symbol) return json(res, 400, { ok: false, error: 'Missing symbol' });
    try {
      const q = await fetchStooq(symbol);
      if (!q) return json(res, 404, { ok: false, error: 'no data' });
      return json(res, 200, { ok: true, quote: q });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // /api/chart
  if (pathname === '/api/chart') {
    const key      = u.searchParams.get('key') || '';
    const interval = u.searchParams.get('interval') || '1d';
    if (!key) return json(res, 400, { ok: false, error: 'Missing key' });
    try {
      const rows = await fetchChartSeries(key, interval);
      if (!rows) return json(res, 404, { ok: false, error: 'no data' });
      return json(res, 200, { ok: true, series: rows });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // /api/stats
  if (pathname === '/api/stats') {
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://finance.daum.net/' };

      let prog = 0;
      try {
        const rN = await fetch('https://finance.naver.com/sise/sise_index.naver?code=KOSPI', { headers });
        const buf = await rN.arrayBuffer();
        const text = new TextDecoder('euc-kr').decode(buf);
        const m = text.match(/전체<br><span class="[^"]+">([+-]?[\d,]+)<span>억/);
        prog = m ? parseInt(m[1].replace(/,/g, '')) : 0;
      } catch (_) {}

      const rKD = await fetch(
        'https://finance.daum.net/api/market_index/days?page=1&perPage=20&market=KOSPI&pagination=true',
        { headers });
      const kospiData = (await rKD.json()).data || [];

      const rQD = await fetch(
        'https://finance.daum.net/api/market_index/days?page=1&perPage=2&market=KOSDAQ&pagination=true',
        { headers });
      const kosdaqData = (await rQD.json()).data || [];

      let kospiTurnover = 0, kosdaqTurnover = 0;
      let kospiTurnoverDiff = '0', kosdaqTurnoverDiff = '0';
      let futuresArray = [0, 0, 0, 0, 0];
      let progsArray   = [prog, 0, 0, 0, 0];

      if (kospiData.length >= 2) {
        kospiTurnover = Math.round(kospiData[0].accTradePrice);
        kospiTurnoverDiff = ((kospiData[0].accTradePrice - kospiData[1].accTradePrice) / 1000000).toFixed(2);
        let sum = 0;
        for (let i = 0; i < kospiData.length && i < 20; i++) {
          sum += Math.round(kospiData[i].foreignStraightPurchasePrice / 100000000);
          if (i === 0)  futuresArray[0] = sum;
          if (i === 2)  futuresArray[1] = sum;
          if (i === 4)  futuresArray[2] = sum;
          if (i === 9)  futuresArray[3] = sum;
          if (i === 19 || i === kospiData.length - 1) futuresArray[4] = sum;
        }
        if (futuresArray[0] !== 0) {
          const ratio = prog / futuresArray[0];
          progsArray = [prog, ...futuresArray.slice(1).map(v => Math.round(v * ratio))];
        } else {
          progsArray = [prog, prog * 3, prog * 5, prog * 10, prog * 20];
        }
      }
      if (kosdaqData.length >= 2) {
        kosdaqTurnover = Math.round(kosdaqData[0].accTradePrice);
        kosdaqTurnoverDiff = ((kosdaqData[0].accTradePrice - kosdaqData[1].accTradePrice) / 1000000).toFixed(2);
      }

      return json(res, 200, {
        ok: true,
        kospiTurnover: kospiTurnover.toLocaleString(),
        kosdaqTurnover: kosdaqTurnover.toLocaleString(),
        kospiTurnoverDiff,
        kosdaqTurnoverDiff,
        futuresArray,
        progsArray,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  return json(res, 404, { ok: false, error: 'Unknown route' });
};
