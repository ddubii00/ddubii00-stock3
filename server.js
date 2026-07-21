const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;
const ROOT = __dirname;

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
const summaryItems = [
  { name: '코스피', symbol: '^KS11', popup: true, popupKey: 'KOSPI' },
  { name: '코스닥', symbol: '^KQ11', popup: true, popupKey: 'KOSDAQ' },
  { name: '나스닥', symbol: '^IXIC', popup: true, popupKey: 'NASDAQ' },
  { name: 'S&P500', symbol: '^GSPC', popup: true, popupKey: 'SP500' }
];
const quoteFallbackKeyMap = {
  '^IXIC': 'NASDAQ',
  '^GSPC': 'SP500',
  '^KS11': 'KOSPI',
  '^KQ11': 'KOSDAQ'
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

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
  const out = { symbol, price, changePercent, asOf: row.localTradedAt, raw: 'naver-index' };
  quoteCache.set(symbol, out);
  return out;
}

async function fetchStooq(symbol) {
  if (symbol === '^KS11' || symbol === '^KQ11') {
    const naverQuote = await fetchNaverIndexQuote(symbol);
    if (naverQuote) return naverQuote;
  }

  // Use Yahoo Finance for accurate real-time change percent for major indices.
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
      // fall back to Stooq CSV if Yahoo fails
    }
  }

  // Default path for other symbols (US indices etc.) – use Stooq CSV for price
  const stooq = quoteMap[symbol];
  if (!stooq) return null;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&e=csv`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const t = (await r.text()).trim();
  const parts = t.split(',');
  if (parts.length < 7) return null;
  const close = Number(parts[6]);
  const open = Number(parts[3]);

  // Compute change percent based on *previous* day's close when possible.
  let changePercent = null;
  const chartKey = quoteFallbackKeyMap[symbol]; // map symbol to chart key (NASDAQ, SP500, KOSPI, KOSDAQ)
  if (chartKey) {
    const series = await fetchChartSeries(chartKey);
    if (series && series.length >= 2) {
      const lastClose = series[series.length - 1].close;
      const prevClose = series[series.length - 2].close;
      if (Number.isFinite(lastClose) && Number.isFinite(prevClose) && prevClose !== 0) {
        // Use the series' close values for percent calculation (aligns with Naver's definition).
        changePercent = ((lastClose - prevClose) / prevClose) * 100;
      }
    }
  }
  // Fallback to open‑based percent if series not available.
  if (changePercent === null) {
    if (Number.isFinite(close) && Number.isFinite(open) && open !== 0) {
      changePercent = ((close - open) / open) * 100;
    } else {
      changePercent = 0;
    }
  }

  const out = {
    symbol,
    price: close,
    changePercent,
    asOf: parts[1],
    raw: t
  };
  quoteCache.set(symbol, out);
  return out;
}

async function fetchChartSeries(key, interval = '1d') {
  if (key === 'US10Y') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'US2Y') {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await r.text();
    const lines = text.trim().split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const parts = lines[i].split(',');
      if (parts.length === 2) {
        const close = Number(parts[1]);
        if (Number.isFinite(close) && close > 0) {
          rows.push({ date: parts[0], close });
        }
      }
    }
    
    // Supplement with Treasury.gov data (for the latest missing days)
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
    } catch (e) {
      console.error('Failed to fetch supplement Treasury data', e);
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'USDKRW') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'VIX') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'SOX') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'WTI') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'DXY') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'GOLD') {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=1y&interval=1d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i += 1) {
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      rows.push({ date, close });
    }
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  const yahooSymbols = {
    'KOSPI': '%5EKS11',
    'KOSDAQ': '%5EKQ11',
    'NASDAQ': '%5EIXIC',
    'SP500': '%5EGSPC'
  };

  if (yahooSymbols[key]) {
    const sym = yahooSymbols[key];
    let rangeStr = '10y';
    let queryInterval = interval;
    let targetMin = 0;
    
    if (interval.endsWith('m')) {
      targetMin = parseInt(interval);
      if (targetMin >= 60) {
        queryInterval = '60m';
        rangeStr = '1y'; // 1 year for 60m+
      } else if (targetMin >= 5) {
        queryInterval = '5m';
        rangeStr = '60d'; // 60 days for 5m to 30m
      } else {
        queryInterval = '1m';
        rangeStr = '7d';  // 7 days for 1m, 3m
      }
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${rangeStr}&interval=${queryInterval}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await r.json();
    const result = json?.chart?.result?.[0];
    let ts = result?.timestamp || [];
    const quotes = result?.indicators?.quote?.[0] || {};
    let opens = quotes.open || [];
    let highs = quotes.high || [];
    let lows = quotes.low || [];
    let closes = quotes.close || [];

    if ((key === 'KOSPI' || key === 'KOSDAQ') && targetMin > 0) {
      try {
        const dUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${rangeStr}&interval=1d`;
        const dRes = await fetch(dUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dJson = await dRes.json();
        const dTs = dJson?.chart?.result?.[0]?.timestamp || [];
        const dCloses = dJson?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        
        let dailyCloses = {};
        for (let j = 0; j < dTs.length; j++) {
           if (dCloses[j]) {
              let dDate = new Date(dTs[j] * 1000).toISOString().slice(0, 10);
              dailyCloses[dDate] = dCloses[j];
           }
        }
        
        let appendedTs = [];
        let appendedOpens = [];
        let appendedHighs = [];
        let appendedLows = [];
        let appendedCloses = [];
        const nowSec = Math.floor(Date.now() / 1000);

        for (let i = 0; i < ts.length; i++) {
           appendedTs.push(ts[i]);
           appendedOpens.push(opens[i]);
           appendedHighs.push(highs[i]);
           appendedLows.push(lows[i]);
           appendedCloses.push(closes[i]);
           
           let curDate = new Date(ts[i] * 1000).toISOString().slice(0, 10);
           let nextDate = (i + 1 < ts.length) ? new Date(ts[i + 1] * 1000).toISOString().slice(0, 10) : null;
           
           if (curDate !== nextDate) {
              let ts1530 = Math.floor(Date.parse(curDate + "T06:30:00Z") / 1000);
              if (nowSec > ts1530 && dailyCloses[curDate] && ts[i] < ts1530) {
                 appendedTs.push(ts1530);
                 appendedOpens.push(closes[i]); 
                 appendedHighs.push(Math.max(closes[i], dailyCloses[curDate]));
                 appendedLows.push(Math.min(closes[i], dailyCloses[curDate]));
                 appendedCloses.push(dailyCloses[curDate]);
              }
           }
        }
        ts = appendedTs;
        opens = appendedOpens;
        highs = appendedHighs;
        lows = appendedLows;
        closes = appendedCloses;
      } catch (e) {
        console.error("Failed to append KOSPI 15:30 candle", e);
      }
    }
    
    const rows = [];
    let currentCandle = null;
    let currentCandlePeriod = null;
    
    for (let i = 0; i < ts.length; i += 1) {
      const open = Number(opens[i]);
      const high = Number(highs[i]);
      const low = Number(lows[i]);
      const close = Number(closes[i]);
      if (!Number.isFinite(close) || close <= 0) continue;
      
      if (targetMin > 0) {
        // Aggregate 1m candles into targetMin candles
        let periodStart = Math.floor(ts[i] / (targetMin * 60)) * (targetMin * 60);
        if (!currentCandle || currentCandlePeriod !== periodStart) {
          if (currentCandle) rows.push(currentCandle);
          currentCandlePeriod = periodStart;
          currentCandle = { date: periodStart + (9 * 3600), open, high, low, close };
        } else {
          currentCandle.high = Math.max(currentCandle.high, high);
          currentCandle.low = Math.min(currentCandle.low, low);
          currentCandle.close = close;
        }
      } else {
        const dateObj = new Date(ts[i] * 1000);
        let dateStr = dateObj.toISOString().slice(0, 10);
        rows.push({ date: dateStr, open, high, low, close });
      }
    }
    if (currentCandle) rows.push(currentCandle);
    if (!rows.length) return null;
    return rows.slice(-1500); // 넉넉하게 1500개 전달 (프론트에서 700개 등 사용)
  }

  const stooq = chartMap[key];
  if (!stooq) return null;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const csv = (await r.text()).trim();
  const lines = csv.split('\n');
  if (lines.length < 3) return null;
  const rows = lines.slice(-120).map((line) => {
    const p = line.split(',');
    return { date: p[0], close: Number(p[4]) };
  }).filter((x) => Number.isFinite(x.close));
  if (!rows.length) return null;
  return rows;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/api/quote') {
    try {
      const symbol = u.searchParams.get('symbol') || '';
      const q = await fetchStooq(symbol);
      if (!q) return send(res, 404, JSON.stringify({ ok: false, error: 'no data' }), 'application/json');
      return send(res, 200, JSON.stringify({ ok: true, quote: q }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (u.pathname === '/api/chart') {
    try {
      const key = u.searchParams.get('key') || '';
      const interval = u.searchParams.get('interval') || '1d';
      const rows = await fetchChartSeries(key, interval);
      if (!rows) return send(res, 404, JSON.stringify({ ok: false, error: 'no data' }), 'application/json');
      return send(res, 200, JSON.stringify({ ok: true, series: rows }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (u.pathname === '/api/stats') {
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://finance.daum.net/' };
      
      // Fetch Naver for Program Trading
      const rKospi = await fetch('https://finance.naver.com/sise/sise_index.naver?code=KOSPI', { headers });
      const bufKospi = await rKospi.arrayBuffer();
      let textKospi = '';
      if (typeof TextDecoder !== 'undefined') {
        textKospi = new TextDecoder('euc-kr').decode(bufKospi);
      } else {
        textKospi = Buffer.from(bufKospi).toString();
      }
      const mProg = textKospi.match(/전체<br><span class="[^"]+">([+-]?[\d,]+)<span>억/);
      const prog = mProg ? parseInt(mProg[1].replace(/,/g, '')) : 0;

      // Fetch Daum for KOSPI / KOSDAQ turnover and foreigner net buying
      const rKospiDaum = await fetch('https://finance.daum.net/api/market_index/days?page=1&perPage=20&market=KOSPI&pagination=true', { headers });
      const jsonKospi = await rKospiDaum.json();
      const kospiData = jsonKospi.data || [];
      
      const rKosdaqDaum = await fetch('https://finance.daum.net/api/market_index/days?page=1&perPage=2&market=KOSDAQ&pagination=true', { headers });
      const jsonKosdaq = await rKosdaqDaum.json();
      const kosdaqData = jsonKosdaq.data || [];
      
      let kospiTurnover = 0, kosdaqTurnover = 0;
      let kospiTurnoverDiff = '0', kosdaqTurnoverDiff = '0';
      let futuresArray = [0, 0, 0, 0, 0];
      let progsArray = [prog, 0, 0, 0, 0];

      if (kospiData.length >= 2) {
        kospiTurnover = Math.round(kospiData[0].accTradePrice);
        const diff = (kospiData[0].accTradePrice - kospiData[1].accTradePrice) / 1000000;
        kospiTurnoverDiff = diff.toFixed(2);
        
        let sum = 0;
        for (let i = 0; i < kospiData.length && i < 20; i++) {
          sum += Math.round(kospiData[i].foreignStraightPurchasePrice / 100000000);
          if (i === 0) futuresArray[0] = sum;
          if (i === 2) futuresArray[1] = sum;
          if (i === 4) futuresArray[2] = sum;
          if (i === 9) futuresArray[3] = sum;
          if (i === 19 || i === kospiData.length - 1) futuresArray[4] = sum;
        }
        if (futuresArray[0] !== 0) {
          const ratio = prog / futuresArray[0];
          progsArray[1] = Math.round(futuresArray[1] * ratio);
          progsArray[2] = Math.round(futuresArray[2] * ratio);
          progsArray[3] = Math.round(futuresArray[3] * ratio);
          progsArray[4] = Math.round(futuresArray[4] * ratio);
        } else {
          progsArray = [prog, prog*3, prog*5, prog*10, prog*20];
        }
      }
      
      if (kosdaqData.length >= 2) {
        kosdaqTurnover = Math.round(kosdaqData[0].accTradePrice);
        const diff = (kosdaqData[0].accTradePrice - kosdaqData[1].accTradePrice) / 1000000;
        kosdaqTurnoverDiff = diff.toFixed(2);
      }

      return send(res, 200, JSON.stringify({
          ok: true,
          kospiTurnover: kospiTurnover.toLocaleString(),
          kosdaqTurnover: kosdaqTurnover.toLocaleString(),
          kospiTurnoverDiff: kospiTurnoverDiff,
          kosdaqTurnoverDiff: kosdaqTurnoverDiff,
          futuresArray,
          progsArray
      }), 'application/json');
    } catch (e) {
      console.error(e);
      return send(res, 500, JSON.stringify({ ok: false }), 'application/json');
    }
  }

  const target = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = path.join(ROOT, target);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');

  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  send(res, 200, fs.readFileSync(file), type);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}
