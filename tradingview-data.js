'use strict';

const WebSocketClient = require('ws');

function message(method, params) {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${Buffer.byteLength(payload)}~m~${payload}`;
}

function resolutionFor(interval) {
  if (interval === '1d') return '1D';
  if (interval === '1wk') return '1W';
  if (interval === '1mo') return '1M';
  return String(Math.max(1, Number.parseInt(interval, 10) || 1));
}

function dateFor(timestamp, interval, offsetSeconds = 0) {
  if (interval.endsWith('m')) return timestamp + offsetSeconds;
  return new Date((timestamp + offsetSeconds) * 1000).toISOString().slice(0, 10);
}

async function fetchTradingViewSeries(candidates, interval = '1d', limit = 240, offsetSeconds = 0) {
  const symbols = Array.isArray(candidates) ? candidates : [candidates];
  return new Promise((resolve) => {
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    const ws = new WebSocketClient('wss://data.tradingview.com/socket.io/websocket?from=chart%2F&date=2026_08_22-00_00', {
      headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' }
    });
    let settled = false;
    const finish = (result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(), 14000);
    ws.on('open', () => {
      ws.send(message('set_auth_token', ['unauthorized_user_token']));
      ws.send(message('chart_create_session', [session, '']));
      symbols.forEach((symbol, index) => {
        const alias = `symbol_${index}`;
        const seriesId = `s${index}`;
        ws.send(message('resolve_symbol', [session, alias, `={"symbol":"${symbol}","adjustment":"splits","session":"extended"}`]));
        ws.send(message('create_series', [session, seriesId, seriesId, alias, resolutionFor(interval), limit]));
      });
    });
    ws.on('message', (data) => {
      const payloads = data.toString().split(/~m~\d+~m~/).filter((part) => part.startsWith('{'));
      for (const payload of payloads) {
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (parsed?.m !== 'timescale_update') continue;
        const update = parsed?.p?.[1] || {};
        for (let index = 0; index < symbols.length; index += 1) {
          const points = update?.[`s${index}`]?.s;
          if (!Array.isArray(points) || !points.length) continue;
          const rows = points.map((point) => {
            const v = point?.v || [];
            const timestamp = Number(v[0]);
            const open = Number(v[1]);
            const high = Number(v[2]);
            const low = Number(v[3]);
            const close = Number(v[4]);
            if (![timestamp, open, high, low, close].every(Number.isFinite) || close <= 0) return null;
            return { date: dateFor(timestamp, interval, offsetSeconds), open, high, low, close };
          }).filter(Boolean);
          if (rows.length) return finish({ symbol: symbols[index], rows: rows.slice(-limit) });
        }
      }
    });
    ws.on('error', () => finish());
    ws.on('close', () => finish());
  });
}

let tradingViewQueue = Promise.resolve();

function fetchTradingViewSeriesQueued(...args) {
  const task = tradingViewQueue.then(() => fetchTradingViewSeries(...args));
  tradingViewQueue = task.catch(() => null);
  return task;
}

const chartSources = {
  US10Y: { symbols: ['TVC:US10Y'], offset: 0 },
  US2Y: { symbols: ['TVC:US02Y'], offset: 0 },
  USDKRW: { symbols: ['FX_IDC:USDKRW', 'OANDA:USDKRW'], offset: 9 * 3600 },
  VIX: { symbols: ['CBOE:VIX'], offset: 0 },
  SOX: { symbols: ['NASDAQ:SOX'], offset: 0 },
  WTI: { symbols: ['NYMEX:CL1!'], offset: 0 },
  DXY: { symbols: ['TVC:DXY'], offset: 0 },
  GOLD: { symbols: ['TVC:GOLD', 'OANDA:XAUUSD'], offset: 0 },
  NASDAQ_FUTURES: { symbols: ['CME_MINI:NQ1!'], offset: 0 },
  KOSPI_FUTURES: { symbols: ['KRX:K2I1!'], offset: 9 * 3600 },
  KOSPI_NIGHT_FUTURES: { symbols: ['KRX:K2I1!'], offset: 9 * 3600 },
  BTC: { symbols: ['BITSTAMP:BTCUSD', 'COINBASE:BTCUSD'], offset: 0 }
};

async function fetchYahooSeries(symbol, interval = '1d') {
  const minute = interval.endsWith('m');
  const range = minute ? '5d' : '2y';
  const yahooInterval = minute ? interval : interval;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${yahooInterval}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) return null;
  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quotes = result?.indicators?.quote?.[0] || {};
  const offset = Number(result?.meta?.gmtoffset) || 0;
  const rows = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = Number(quotes.open?.[i]);
    const high = Number(quotes.high?.[i]);
    const low = Number(quotes.low?.[i]);
    const close = Number(quotes.close?.[i]);
    if (![open, high, low, close].every(Number.isFinite) || close <= 0) continue;
    const date = minute
      ? Number(timestamps[i]) + offset
      : new Date((Number(timestamps[i]) + offset) * 1000).toISOString().slice(0, 10);
    rows.push({ date, open, high, low, close });
  }
  return rows.length ? rows : null;
}

async function fetchNaverIndexClosingMinutes(key, date, targetMin = 1) {
  if (!['KOSPI', 'KOSDAQ'].includes(key) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const compactDate = date.replace(/-/g, '');
  const times = ['1501', '1505', '1510', '1515', '1520', '1525', '1529', '1530'];
  const snapshots = await Promise.all(times.map(async (hhmm) => {
    try {
      const url = `https://stock.naver.com/api/domestic/indexSise/time?koreaIndexType=${key}&thistime=${compactDate}${hhmm}00&startIdx=0&pageSize=20`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://stock.naver.com/' } });
      if (!response.ok) return null;
      const payload = await response.json();
      const row = Array.isArray(payload) ? payload[0] : null;
      const close = Number(row?.nowVal);
      if (!row || !Number.isFinite(close) || close <= 0) return null;
      const rawTimestamp = Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`) / 1000;
      const intervalSeconds = Math.max(1, Number(targetMin) || 1) * 60;
      const timestamp = Math.floor(rawTimestamp / intervalSeconds) * intervalSeconds;
      const open = Number(row.openVal);
      const high = Number(row.highVal);
      const low = Number(row.lowVal);
      return {
        date: timestamp,
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close
      };
    } catch (_) {
      return null;
    }
  }));
  const byTimestamp = new Map();
  snapshots.filter(Boolean).forEach((row) => byTimestamp.set(row.date, row));
  return [...byTimestamp.values()].sort((a, b) => a.date - b.date);
}

async function fetchUnifiedSeries(key, interval = '1d') {
  const source = chartSources[key];
  if (!source) return null;
  const yahooSymbols = { USDKRW: 'KRW=X', GOLD: 'GC=F', BTC: 'BTC-USD', NASDAQ_FUTURES: 'NQ=F' };
  if (yahooSymbols[key]) {
    const yahooRows = await fetchYahooSeries(yahooSymbols[key], interval).catch(() => null);
    if (yahooRows?.length) return yahooRows.slice(interval.endsWith('m') ? -900 : -260);
  }
  const limit = interval.endsWith('m') ? (key === 'KOSPI_FUTURES' ? 1800 : 900) : 260;
  let result = await fetchTradingViewSeriesQueued(source.symbols, interval, limit, source.offset);
  if (!result?.rows?.length) {
    await new Promise((resolve) => setTimeout(resolve, 350 + key.length * 45));
    result = await fetchTradingViewSeriesQueued(source.symbols, interval, limit, source.offset);
  }
  return result?.rows?.length ? result.rows : null;
}

async function fetchBondYields() {
  const bonds = [
    { key: 'US', name: '미국 국채 10년', flag: '🇺🇸', symbols: ['TVC:US10Y'], realtime: true },
    { key: 'KR', name: '한국 국채 10년', flag: '🇰🇷', symbols: ['TVC:KR10Y'], realtime: false },
    { key: 'JP', name: '일본 국채 10년', flag: '🇯🇵', symbols: ['TVC:JP10Y'], realtime: false },
    { key: 'DE', name: '독일 국채 10년', flag: '🇩🇪', symbols: ['TVC:DE10Y'], realtime: false },
    { key: 'CN', name: '중국 국채 10년', flag: '🇨🇳', symbols: ['TVC:CN10Y'], realtime: false }
  ];
  const rows = [];
  for (const bond of bonds) {
    let result = await fetchTradingViewSeriesQueued(bond.symbols, '1d', 3, 0);
    if (!result?.rows?.length) result = await fetchTradingViewSeriesQueued(bond.symbols, '1d', 3, 0);
    const series = result?.rows || [];
    if (!series.length) {
      rows.push({ ...bond, unavailable: true });
      continue;
    }
    const last = series[series.length - 1];
    const previous = series[series.length - 2];
    const change = previous ? last.close - previous.close : 0;
    const changePercent = previous?.close ? change / previous.close * 100 : 0;
    rows.push({ ...bond, value: last.close, change, changePercent, asOf: last.date, source: result.symbol });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return rows;
}

module.exports = { fetchTradingViewSeries, fetchUnifiedSeries, fetchBondYields, fetchNaverIndexClosingMinutes };
