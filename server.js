const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocketClient = require('ws');

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

function formatYmd(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetries(url, options = {}, attempts = 3, encoding = 'utf-8') {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const r = await fetchWithTimeout(url, options, 12000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = Buffer.from(await r.arrayBuffer());
      return new TextDecoder(encoding).decode(buffer);
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError || new Error('fetch failed');
}

async function fetchFredYieldSeries(fredId, minValue = 0.1) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await r.text();
  const lines = text.trim().split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(',');
    const close = Number(parts[1]);
    if (parts[0] && Number.isFinite(close) && close > minValue && close < 20) {
      rows.push({ date: parts[0], close });
    }
  }
  return rows;
}

async function supplementTreasuryYield(rows, fieldName) {
  try {
    const year = new Date().getFullYear();
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await r.text();
    const dates = [...xml.matchAll(/<d:NEW_DATE[^>]*>([^<T]+)T/g)].map(m => m[1]);
    const values = [...xml.matchAll(new RegExp(`<d:${fieldName}[^>]*>([^<]+)</d:${fieldName}>`, 'g'))].map(m => Number(m[1]));
    const seen = new Set(rows.map(row => row.date));
    for (let i = 0; i < dates.length; i += 1) {
      const close = values[i];
      if (!seen.has(dates[i]) && Number.isFinite(close) && close > 0.1 && close < 20) {
        rows.push({ date: dates[i], close });
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.error('Failed to supplement Treasury yield data', e);
  }
  return rows;
}

async function fetchDaumInvestorDays(market = 'KOSPI', limit = 200) {
  const safeMarket = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  const url = `https://finance.daum.net/api/market_index/days?page=1&perPage=${safeLimit}&market=${safeMarket}&pagination=true`;
  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://finance.daum.net/'
    }
  });
  const json = await r.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.reverse().map((row) => ({
    date: String(row.date || '').slice(0, 10),
    foreign: Number(row.foreignStraightPurchasePrice) / 1000000000000,
    institution: Number(row.institutionStraightPurchasePrice) / 1000000000000
  })).filter((row) => row.date && Number.isFinite(row.foreign) && Number.isFinite(row.institution));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTrendNumber(value) {
  const cleaned = stripHtml(value).replace(/,/g, '').replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchNaverInvestorTimeRows(market = 'KOSPI') {
  const safeMarket = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const sosok = safeMarket === 'KOSDAQ' ? '02' : '01';
  const dayRows = await fetchDaumInvestorDays(safeMarket, 1);
  const latestDate = dayRows[dayRows.length - 1]?.date || new Date().toISOString().slice(0, 10);
  const bizdate = latestDate.replace(/-/g, '');
  const rows = [];
  const seen = new Set();

  let emptyPages = 0;
  for (let page = 1; page <= 40; page += 1) {
    const url = `https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=${bizdate}&sosok=${sosok}&page=${page}`;
    let text = '';
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const r = await fetchWithTimeout(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://finance.naver.com/'
          }
        }, 10000);
        const buffer = Buffer.from(await r.arrayBuffer());
        text = new TextDecoder('euc-kr').decode(buffer);
        break;
      } catch (e) {
        lastError = e;
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    if (!text) {
      if (page === 1) throw lastError || new Error('Naver investor minute fetch failed');
      emptyPages += 1;
      if (emptyPages >= 8) break;
      continue;
    }

    const tableRows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let foundInPage = 0;
    for (const match of tableRows) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripHtml(m[1]));
      if (cells.length < 4) continue;
      const time = cells[0].match(/\d{2}:\d{2}/)?.[0];
      if (!time) continue;
      const foreign = parseTrendNumber(cells[2]);
      const institution = parseTrendNumber(cells[3]);
      if (!Number.isFinite(foreign) || !Number.isFinite(institution)) continue;
      const date = `${latestDate} ${time}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, foreign: foreign / 10000, institution: institution / 10000 });
      foundInPage += 1;
    }
    if (!foundInPage) {
      emptyPages += 1;
      if (emptyPages >= 8) break;
    } else {
      emptyPages = 0;
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const regularRows = rows.filter((row) => {
    const time = String(row.date || '').split(' ')[1] || '';
    return time >= '09:00' && time <= '15:30';
  });
  const series = regularRows.length >= 5 ? regularRows : rows;
  return {
    unit: '조원',
    note: `${safeMarket} 최신 거래일(${latestDate}) 시간별 누적 순매수, 단위: 조원. 휴장일에는 직전 거래일 기준입니다.`,
    series
  };
}

async function fetchInvestorSeries(market, kind, limit = 200) {
  const safeMarket = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const marketLabel = safeMarket === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  if (kind === 'minute') {
    return fetchNaverInvestorTimeRows(safeMarket);
  }
  const rows = await fetchDaumInvestorDays(safeMarket, limit);
  if (!rows.length) return null;
  let foreignTotal = 0;
  let institutionTotal = 0;
  const cumulativeRows = rows.map((row) => {
    foreignTotal += row.foreign;
    institutionTotal += row.institution;
    return {
      date: row.date,
      foreign: foreignTotal,
      institution: institutionTotal
    };
  });
  return { unit: '조원', note: `${marketLabel} ${cumulativeRows.length}거래일 누적 순매수, 단위: 조원`, series: cumulativeRows };
}

async function fetchForeignFuturesSeries(limit = 200) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 200));
  const rows = [];
  const seen = new Set();
  const bizdate = formatYmd(new Date());
  const maxPages = Math.ceil(safeLimit / 10) + 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=03&page=${page}`;
    const html = await fetchTextWithRetries(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/sise/'
      }
    }, 3, 'euc-kr');
    const tableRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let foundInPage = 0;

    for (const match of tableRows) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripHtml(m[1]));
      if (cells.length < 3 || !/^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) continue;
      const foreign = parseTrendNumber(cells[2]);
      if (!Number.isFinite(foreign)) continue;
      const [yy, mm, dd] = cells[0].split('.');
      const date = `20${yy}-${mm}-${dd}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, foreign });
      foundInPage += 1;
    }

    if (!foundInPage && page > 1) break;
    if (rows.length >= safeLimit) break;
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  let cumulativeForeign = 0;
  const series = rows.slice(-safeLimit).map((row) => {
    cumulativeForeign += row.foreign;
    return { date: row.date, dailyForeign: row.foreign, foreign: cumulativeForeign };
  });
  const latest = series[series.length - 1]?.date || '';
  return {
    unit: '계약',
    note: `네이버 선물 일자별 순매수 ${series.length}거래일 누적, 최신 거래일(${latest}), 단위: 계약.`,
    series
  };
}

async function fetchMarketTurnoverSeries(limit = 200) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 200));
  const fetchMarket = async (market) => {
    const url = `https://finance.daum.net/api/market_index/days?page=1&perPage=${safeLimit}&market=${market}&pagination=true`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.daum.net/'
      }
    });
    const json = await response.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows.map((row) => ({
      date: String(row.date || '').slice(0, 10),
      value: Number(row.accTradePrice) / 1000000
    })).filter((row) => row.date && Number.isFinite(row.value));
  };

  const [kospiRows, kosdaqRows] = await Promise.all([fetchMarket('KOSPI'), fetchMarket('KOSDAQ')]);
  const kospiByDate = new Map(kospiRows.map((row) => [row.date, row.value]));
  const kosdaqByDate = new Map(kosdaqRows.map((row) => [row.date, row.value]));
  const series = [...kospiByDate.keys()]
    .filter((date) => kosdaqByDate.has(date))
    .sort()
    .slice(-safeLimit)
    .map((date) => ({ date, kospi: kospiByDate.get(date), kosdaq: kosdaqByDate.get(date) }));
  if (!series.length) return null;
  const latest = series[series.length - 1]?.date || '';
  return {
    unit: '조원',
    note: `Daum Finance 시장별 일일 거래대금 최신 거래일(${latest}) 기준, 단위: 조원.`,
    series
  };
}

async function fetchMarketFundsSeries(limit = 200) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 200));
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page += 1) {
    const url = `https://finance.naver.com/sise/sise_deposit.naver?&page=${page}`;
    const html = await fetchTextWithRetries(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/sise/'
      }
    }, 3, 'euc-kr');
    const tableRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let foundInPage = 0;
    for (const match of tableRows) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripHtml(m[1]));
      const dateCell = cells.find((cell) => /^\d{2}\.\d{2}\.\d{2}$/.test(cell));
      if (!dateCell) continue;
      if (cells.length < 4) continue;
      const deposit = parseTrendNumber(cells[1]);
      const credit = parseTrendNumber(cells[3]);
      if (!Number.isFinite(deposit) || !Number.isFinite(credit)) continue;
      const [yy, mm, dd] = dateCell.split('.');
      const date = `20${yy}-${mm}-${dd}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({
        date,
        deposit: deposit / 10000,
        credit: credit / 10000
      });
      foundInPage += 1;
    }
    if (!foundInPage && page > 1) break;
    if (rows.length >= safeLimit) break;
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  const latest = rows[rows.length - 1]?.date || '';
  return {
    unit: '조원',
    note: `네이버 증시자금동향 최신일(${latest}) 기준, 단위: 조원. 금융투자협회 통계 기반 메뉴의 공개값입니다.`,
    series: rows.slice(-safeLimit)
  };
}

function parseInvestingDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) return '';
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const month = months[match[1]];
  if (!month) return '';
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
}

function parseInvestingHistoricalPayload(text) {
  const rows = [];
  try {
    const json = JSON.parse(text);
    const candidates = Array.isArray(json) ? json : (json?.data || json?.series || json?.historicalData || []);
    for (const row of candidates) {
      const rawDate = row?.date || row?.rowDate || row?.rowDateRaw || row?.time || '';
      const date = parseInvestingDate(rawDate) || (/^\d{10,13}$/.test(String(rawDate))
        ? new Date(Number(rawDate) * (String(rawDate).length === 10 ? 1000 : 1)).toISOString().slice(0, 10)
        : '');
      const close = parseTrendNumber(row?.close ?? row?.last_close ?? row?.lastClose ?? row?.price ?? row?.last);
      if (date && Number.isFinite(close) && close > 0) rows.push({ date, close });
    }
  } catch {
    for (const line of String(text || '').split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const date = parseInvestingDate(cells[0]);
      const close = parseTrendNumber(cells[1]);
      if (date && Number.isFinite(close) && close > 0) rows.push({ date, close });
    }
  }
  const unique = new Map(rows.map((row) => [row.date, row]));
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchInvestingVkospi(limit, start, end) {
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' };
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const apiUrl = `https://api.investing.com/api/financialdata/historical/956761?start-date=${startDate}&end-date=${endDate}&interval=P1D&time-frame=Daily`;
  const pageUrl = 'https://www.investing.com/indices/kospi-volatility-historical-data';
  const urls = [
    `https://r.jina.ai/http://${apiUrl.replace(/^https?:\/\//, '')}`,
    `https://r.jina.ai/http://${pageUrl.replace(/^https?:\/\//, '')}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(pageUrl)}`
  ];
  const attempts = await Promise.allSettled(urls.map(async (url) => {
    const r = await fetchWithTimeout(url, { headers }, 15000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseInvestingHistoricalPayload(await r.text());
  }));
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled' && attempt.value.length) return attempt.value.slice(-limit);
  }
  return [];
}

function tradingViewMessage(method, params) {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${Buffer.byteLength(payload)}~m~${payload}`;
}

async function fetchTradingViewVkospi(limit) {
  const candidates = ['KRX:VKI1!'];
  return new Promise((resolve) => {
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    const ws = new WebSocketClient('wss://data.tradingview.com/socket.io/websocket?from=symbols%2FKRX-VKOSPI%2F&date=2026_08_15-12_00', {
      headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' }
    });
    let settled = false;
    const finish = (result = { rows: [], symbol: '' }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* Ignore close errors. */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(), 12000);
    ws.on('open', () => {
      ws.send(tradingViewMessage('set_auth_token', ['unauthorized_user_token']));
      ws.send(tradingViewMessage('chart_create_session', [session, '']));
      candidates.forEach((symbol, index) => {
        const alias = `symbol_${index}`;
        const seriesId = `s${index}`;
        ws.send(tradingViewMessage('resolve_symbol', [session, alias, `={"symbol":"${symbol}","adjustment":"splits","session":"regular"}`]));
        ws.send(tradingViewMessage('create_series', [session, seriesId, seriesId, alias, '1D', limit]));
      });
    });
    ws.on('message', (data) => {
      const text = data.toString();
      const payloads = text.split(/~m~\d+~m~/).filter((part) => part.startsWith('{'));
      for (const payload of payloads) {
        let message;
        try { message = JSON.parse(payload); } catch { continue; }
        if (message?.m !== 'timescale_update') continue;
        const update = message?.p?.[1] || {};
        for (let index = 0; index < candidates.length; index += 1) {
          const points = update?.[`s${index}`]?.s;
          if (!Array.isArray(points) || !points.length) continue;
          const rows = points.map((point) => {
            const values = point?.v || [];
            return {
              date: Number.isFinite(Number(values[0])) ? new Date(Number(values[0]) * 1000 + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : '',
              close: Number(values[4])
            };
          }).filter((row) => row.date && Number.isFinite(row.close) && row.close > 0);
          const uniqueRows = [...new Map(rows.map((row) => [row.date, row])).values()];
          if (uniqueRows.length) return finish({ rows: uniqueRows.slice(-limit), symbol: candidates[index] });
        }
      }
    });
    ws.on('error', (error) => {
      console.error('TradingView VKOSPI websocket error', error.message);
      finish();
    });
    ws.on('close', (code) => {
      if (!settled) console.error('TradingView VKOSPI websocket closed', code);
      finish();
    });
  });
}

async function fetchVkospiSeries(limit = 200) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 200));
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(300, safeLimit * 2));
  try {
    const body = new URLSearchParams({
      bld: 'dbms/MDC/STAT/standard/MDCSTAT00301',
      locale: 'ko_KR',
      indIdx: '1',
      indIdx2: '167',
      strtDd: formatYmd(start),
      endDd: formatYmd(end),
      share: '1',
      money: '1',
      csvxls_isNo: 'false'
    });
    const r = await fetchWithTimeout('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    }, 5000);
    if (!r.ok) throw new Error(`KRX HTTP ${r.status}`);
    const text = await r.text();
    const json = JSON.parse(text);
    const rawRows = Array.isArray(json?.output) ? json.output : Array.isArray(json?.OutBlock_1) ? json.OutBlock_1 : [];
    const rows = rawRows.map((row) => {
      const rawDate = row.TRD_DD || row.trdDd || row.일자 || row.basDd || row.BAS_DD || '';
      const rawClose = row.CLSPRC_IDX || row.CLS_IDX || row.close || row.종가 || row.CLSPRC || row.clsprcIdx || '';
      const date = String(rawDate).replace(/\./g, '-').replace(/\//g, '-').replace(/\s+/g, '');
      const close = parseTrendNumber(rawClose);
      return { date, close };
    }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length) {
      const latest = rows[rows.length - 1]?.date || '';
      return { unit: 'P', note: `KRX V-KOSPI 200 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`, series: rows.slice(-safeLimit) };
    }
  } catch (e) {
    console.error('Failed to fetch VKOSPI from KRX', e);
  }
  const tradingViewResult = await fetchTradingViewVkospi(safeLimit);
  if (tradingViewResult.rows.length) {
    const latest = tradingViewResult.rows[tradingViewResult.rows.length - 1]?.date || '';
    const isFutures = tradingViewResult.symbol === 'KRX:VKI1!';
    return {
      unit: 'P',
      note: isFutures
        ? `VKOSPI 현물 공개 원천 차단으로 KRX V-KOSPI 200 선물 연속계약(VKI1!) 실제 일봉을 표시합니다. 최신 거래일(${latest}) 기준입니다.`
        : `TradingView VKOSPI 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`,
      series: tradingViewResult.rows
    };
  }
  const investingRows = await fetchInvestingVkospi(safeLimit, start, end);
  if (investingRows.length) {
    const latest = investingRows[investingRows.length - 1]?.date || '';
    return {
      unit: 'P',
      note: `Investing.com KOSPI Volatility(KSVKOSPI) 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`,
      series: investingRows
    };
  }
  const candidates = ['%5EVKOSPI', 'VKOSPI.KS', 'VKOSPI'];
  for (const symbol of candidates) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000);
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const rows = [];
      for (let i = 0; i < ts.length; i += 1) {
        const close = Number(closes[i]);
        if (!Number.isFinite(close) || close <= 0) continue;
        rows.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close });
      }
      if (rows.length) {
        const latest = rows[rows.length - 1]?.date || '';
        return { unit: 'P', note: `최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`, series: rows.slice(-safeLimit) };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {
    unavailable: true,
    error: 'VKOSPI 원천 데이터 확인 필요: KRX Open API는 인증키가 필요하고, Investing.com 공개 표는 서버 호출이 차단됩니다. 가짜 데이터로 대체하지 않았습니다.'
  };
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
    const rows = await supplementTreasuryYield(await fetchFredYieldSeries('DGS10', 0.2), 'BC_10YEAR');
    if (!rows.length) return null;
    return rows.slice(-120);
  }
  if (key === 'US2Y') {
    const rows = await supplementTreasuryYield(await fetchFredYieldSeries('DGS2', 0.1), 'BC_2YEAR');
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
  if (u.pathname === '/api/extra-chart') {
    try {
      const kind = u.searchParams.get('kind') || '';
      const days = Number(u.searchParams.get('days') || 200);
      let payload = null;
      if (kind === 'kospi-investor-daily') payload = await fetchInvestorSeries('KOSPI', 'daily', days);
      if (kind === 'kospi-investor-minute') payload = await fetchInvestorSeries('KOSPI', 'minute', days);
      if (kind === 'kosdaq-investor-daily') payload = await fetchInvestorSeries('KOSDAQ', 'daily', days);
      if (kind === 'kosdaq-investor-minute') payload = await fetchInvestorSeries('KOSDAQ', 'minute', days);
      if (kind === 'market-funds') payload = await fetchMarketFundsSeries(days);
      if (kind === 'vkospi') payload = await fetchVkospiSeries(days);
      if (kind === 'foreign-futures-daily') payload = await fetchForeignFuturesSeries(days);
      if (kind === 'market-turnover-daily') payload = await fetchMarketTurnoverSeries(days);
      if (!payload) return send(res, 404, JSON.stringify({ ok: false, error: 'no data' }), 'application/json');
      if (payload.unavailable) return send(res, 404, JSON.stringify({ ok: false, error: payload.error }), 'application/json');
      return send(res, 200, JSON.stringify({ ok: true, ...payload }), 'application/json');
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
      const futuresPayload = await fetchForeignFuturesSeries(20);
      
      let kospiTurnover = 0, kosdaqTurnover = 0;
      let kospiTurnoverDiff = '0', kosdaqTurnoverDiff = '0';
      let futuresArray = [0, 0, 0, 0, 0];
      let progsArray = [prog, 0, 0, 0, 0];

      if (kospiData.length >= 2) {
        kospiTurnover = Math.round(kospiData[0].accTradePrice);
        const diff = ((kospiData[0].accTradePrice - kospiData[1].accTradePrice) / kospiData[1].accTradePrice) * 100;
        kospiTurnoverDiff = Math.abs(diff) < 0.005 ? '0' : diff.toFixed(2);
        
        const recentFutures = (futuresPayload?.series || []).slice().reverse().map((row) => Number(row.dailyForeign) || 0);
        futuresArray = [1, 3, 5, 10, 20].map((days) => recentFutures.slice(0, days).reduce((sum, value) => sum + value, 0));
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
        const diff = ((kosdaqData[0].accTradePrice - kosdaqData[1].accTradePrice) / kosdaqData[1].accTradePrice) * 100;
        kosdaqTurnoverDiff = Math.abs(diff) < 0.005 ? '0' : diff.toFixed(2);
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
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = {
  fetchInvestorSeries,
  fetchMarketFundsSeries,
  fetchVkospiSeries,
  fetchForeignFuturesSeries,
  fetchMarketTurnoverSeries
};
