const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocketClient = require('ws');
const { fetchUnifiedSeries, fetchBondYields, fetchNaverIndexClosingMinutes } = require('./tradingview-data');
const { fetchHighBreakouts } = require('./breakout-data');
const { fetchDashboardPanels, fetchBinanceKoreaFutures, fetchInvestorTopFlows } = require('./dashboard-data');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;

function normalizeApiPath(pathname) {
  const match = String(pathname || '').match(/^\/[^/]+(\/api\/.*)$/);
  return match ? match[1] : pathname;
}

function resolveStaticPath(pathname) {
  const cleanPath = String(pathname || '/');
  if (cleanPath === '/' || /^\/[^/.]+\/?$/.test(cleanPath) || /^\/[^/]+\/index\.html$/.test(cleanPath)) {
    return '/index.html';
  }
  const directFile = path.join(ROOT, cleanPath);
  if (directFile.startsWith(ROOT) && fs.existsSync(directFile)) return cleanPath;
  const stripped = cleanPath.replace(/^\/[^/]+(?=\/)/, '');
  const strippedFile = path.join(ROOT, stripped);
  return strippedFile.startsWith(ROOT) && fs.existsSync(strippedFile) ? stripped : cleanPath;
}

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
const marketFundsCache = new Map();
const marketFundsInFlight = new Map();
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

function getKoreaClock() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function formatKoreaMinute(timestampSeconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(timestampSeconds * 1000)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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

async function fetchDaumInvestorDays(market = 'KOSPI', limit = 120) {
  const safeMarket = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
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
    individual: Number(row.individualStraightPurchasePrice) / 1000000000000,
    foreign: Number(row.foreignStraightPurchasePrice) / 1000000000000,
    institution: Number(row.institutionStraightPurchasePrice) / 1000000000000
  })).filter((row) => row.date && Number.isFinite(row.individual) && Number.isFinite(row.foreign) && Number.isFinite(row.institution));
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
      const individual = parseTrendNumber(cells[1]);
      const foreign = parseTrendNumber(cells[2]);
      const institution = parseTrendNumber(cells[3]);
      if (!Number.isFinite(individual) || !Number.isFinite(foreign) || !Number.isFinite(institution)) continue;
      const date = `${latestDate} ${time}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, individual: individual / 10000, foreign: foreign / 10000, institution: institution / 10000 });
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
  const finalDaily = dayRows[dayRows.length - 1];
  const koreaClock = getKoreaClock();
  const shouldAppendClose = latestDate < koreaClock.date || koreaClock.minutes >= 15 * 60 + 30;
  if (shouldAppendClose && finalDaily && Number.isFinite(finalDaily.individual) && Number.isFinite(finalDaily.foreign) && Number.isFinite(finalDaily.institution)) {
    const closeDate = `${latestDate} 15:30`;
    const closeRow = { date: closeDate, individual: finalDaily.individual, foreign: finalDaily.foreign, institution: finalDaily.institution, final: true };
    const existingIndex = series.findIndex((row) => row.date === closeDate);
    if (existingIndex >= 0) series[existingIndex] = closeRow;
    else series.push(closeRow);
    series.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    unit: '조원',
    note: `${safeMarket} 최신 거래일(${latestDate}) 시간별 누적 순매수. 15:30은 확정 일봉 순매수 반영, 단위: 조원.`,
    series
  };
}

async function fetchInvestorSeries(market, kind, limit = 120) {
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
      dailyForeign: row.foreign,
      dailyInstitution: row.institution,
      foreign: foreignTotal,
      institution: institutionTotal
    };
  });
  return { unit: '조원', note: `${marketLabel} ${cumulativeRows.length}거래일 누적 순매수, 단위: 조원`, series: cumulativeRows };
}

async function fetchForeignFuturesSeries(limit = 120) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 120));
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

async function fetchForeignFuturesMinuteSeries() {
  const dailyPayload = await fetchForeignFuturesSeries(20);
  const latestDaily = dailyPayload?.series?.[dailyPayload.series.length - 1];
  if (!latestDaily?.date) return null;
  const latestDate = latestDaily.date;
  const bizdate = latestDate.replace(/-/g, '');
  const rows = [];
  const seen = new Set();

  let emptyPages = 0;
  for (let page = 1; page <= 40; page += 1) {
    const url = `https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=${bizdate}&sosok=03&page=${page}`;
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
      const time = cells[0]?.match(/^\d{2}:\d{2}$/)?.[0];
      const foreign = parseTrendNumber(cells[2]);
      if (!time || !Number.isFinite(foreign) || time < '09:00' || time > '15:45') continue;
      const date = `${latestDate} ${time}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, foreign });
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
  if (!rows.length) return null;
  if (Number.isFinite(Number(latestDaily.dailyForeign))) {
    const closeDate = `${latestDate} 15:45`;
    const closeRow = { date: closeDate, foreign: Number(latestDaily.dailyForeign), final: true };
    const closeIndex = rows.findIndex((row) => row.date === closeDate);
    if (closeIndex >= 0) rows[closeIndex] = closeRow;
    else rows.push(closeRow);
    rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    unit: '계약',
    note: `네이버 선물 최신 거래일(${latestDate}) 시간별 외국인 누적 순매수. 15:45은 확정 일봉 반영, 단위: 계약.`,
    series: rows
  };
}

async function fetchPriceMinuteSeries(key, label, unit) {
  let rows = null;
  for (let attempt = 1; attempt <= 3 && !rows?.length; attempt += 1) {
    rows = await fetchChartSeries(key, '1m').catch(() => null);
    if (!rows?.length && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 450 * attempt));
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  let series = rows.slice(key === 'KOSPI_FUTURES' ? -3200 : -5000).map((row) => {
    const timestamp = Number(row.date);
    const close = Number(row.close);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) return null;
    const date = formatKoreaMinute(timestamp);
    return { date, close };
  }).filter(Boolean);
  if (key === 'KOSPI_FUTURES') {
    const regularSession = series.filter((row) => {
      const time = row.date.slice(11, 16);
      return time >= '08:45' && time <= '15:45';
    });
    if (regularSession.length) series = regularSession;
  }
  if (!series.length) return null;
  const latestDate = series[series.length - 1].date.slice(0, 10);
  const previousRows = series.filter((row) => row.date.slice(0, 10) < latestDate);
  const previousClose = previousRows.length ? previousRows[previousRows.length - 1].close : null;
  const latestSeries = series.filter((row) => row.date.startsWith(latestDate));
  return {
    unit,
    note: `${label} 최신 거래일(${latestDate}) 1분봉, 1분마다 갱신.`,
    previousClose,
    series: latestSeries.length ? latestSeries : series
  };
}

async function fetchMarketTurnoverSeries(limit = 120) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 120));
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

async function fetchFredCsvRows(seriesId) {
  const response = await fetchWithTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fred.stlouisfed.org/' }
  }, 10000);
  if (!response.ok) throw new Error(`FRED ${seriesId} HTTP ${response.status}`);
  const csv = await response.text();
  return csv.trim().split('\n').slice(1).map((line) => {
    const [date, value] = line.split(',');
    const numeric = parseTrendNumber(value);
    return { date, value: numeric };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.value));
}

function filterLastYears(rows, years = 10) {
  const latest = rows[rows.length - 1]?.date;
  if (!latest) return rows;
  const cutoff = new Date(`${latest}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff);
}

function monthlyLast(rows) {
  const byMonth = new Map();
  rows.forEach((row) => byMonth.set(row.date.slice(0, 7), row));
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function addYearOverYear(rows, valueKey = 'value', outputKey = 'yoy') {
  const byMonth = new Map(rows.map((row) => [row.date.slice(0, 7), row]));
  return rows.map((row) => {
    const previousYear = `${Number(row.date.slice(0, 4)) - 1}${row.date.slice(4, 7)}`;
    const previous = byMonth.get(previousYear);
    const currentValue = Number(row[valueKey]);
    const previousValue = Number(previous?.[valueKey]);
    const yoy = Number.isFinite(currentValue) && Number.isFinite(previousValue) && previousValue !== 0
      ? ((currentValue - previousValue) / previousValue) * 100
      : null;
    return { ...row, [outputKey]: yoy };
  });
}

async function fetchRichCounterM2Rows(country) {
  const response = await fetchWithTimeout(`https://richcounter.com/api/indices/m2-series?country=${encodeURIComponent(country)}&since=2010-01`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://richcounter.com/indices/m2' }
  }, 12000);
  if (!response.ok) throw new Error(`M2 ${country} HTTP ${response.status}`);
  const json = await response.json();
  const rows = (Array.isArray(json?.series) ? json.series : []).map((row) => {
    const month = String(row.date || '').slice(0, 7);
    const value = Number(row.value);
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(value) || value <= 0) return null;
    return { date: `${month}-01`, value };
  }).filter(Boolean);
  if (!rows.length) throw new Error(`M2 ${country} no data`);
  return {
    unit: json.unit || (country === 'KR' ? 'KRW' : 'USD'),
    lastUpdated: json.lastUpdated || '',
    rows: rows.sort((a, b) => a.date.localeCompare(b.date))
  };
}

async function fetchM2TrendSeries() {
  const source = await fetchRichCounterM2Rows('KR');
  const rows = addYearOverYear(monthlyLast(source.rows).map((row) => ({
    date: row.date,
    m2: row.value / 1000000000000
  })), 'm2', 'm2Yoy');
  const latest = rows[rows.length - 1]?.date?.slice(0, 7) || '';
  return {
    unit: '조원/%',
    note: `한국 M2 통화량(한국은행 ECOS 기반 공개 API). 값은 조원, YoY는 전년동월 대비입니다. 최신월: ${latest}.`,
    lastUpdated: source.lastUpdated,
    series: filterLastYears(rows.filter((row) => Number.isFinite(row.m2)), 15)
  };
}

async function fetchUsM2TrendSeries() {
  const source = await fetchRichCounterM2Rows('US').catch(() => null);
  const rawRows = source?.rows?.length ? source.rows : await fetchFredCsvRows('M2SL');
  const divisor = source?.rows?.length ? 1000000000000 : 1000;
  const rows = addYearOverYear(monthlyLast(rawRows).map((row) => ({
    date: row.date,
    m2: row.value / divisor
  })), 'm2', 'm2Yoy');
  const latest = rows[rows.length - 1]?.date?.slice(0, 7) || '';
  return {
    unit: '조달러/%',
    note: `미국 M2 통화량(FRED M2SL 기반 공개 API). 값은 조달러, YoY는 전년동월 대비입니다. 최신월: ${latest}.`,
    lastUpdated: source?.lastUpdated || '',
    series: filterLastYears(rows.filter((row) => Number.isFinite(row.m2)), 15)
  };
}

async function fetchKredBokAssetYoyRows() {
  const html = await fetchTextWithRetries('https://kred.dev/en/series/KRBOKASSET', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://kred.dev/' }
  }, 2, 'utf-8');
  const embeddedRows = [...html.matchAll(/\\?"date\\?":\\?"(\d{4}-\d{2}-\d{2})\\?",\\?"value\\?":([\d.]+)/g)]
    .map((match) => ({ date: match[1], value: Number(match[2]) }));
  const tableRows = [...html.matchAll(/<td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d,.]+)<\/td>/g)]
    .map((match) => ({ date: match[1], value: parseTrendNumber(match[2]) }));
  const byDate = new Map([...embeddedRows, ...tableRows].map((row) => [row.date, row]));
  const observations = [...byDate.values()]
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byMonth = new Map(observations.map((row) => [row.date.slice(0, 7), row]));
  const rows = observations.map((row) => {
    const previousMonth = `${Number(row.date.slice(0, 4)) - 1}${row.date.slice(4, 7)}`;
    const previous = byMonth.get(previousMonth);
    const yoy = previous?.value ? ((row.value - previous.value) / previous.value) * 100 : null;
    return { date: row.date, bokYoy: yoy };
  }).filter((row) => Number.isFinite(row.bokYoy));
  const latest = observations[observations.length - 1];
  const yoyAmountMatch = html.match(/Change over one year[\s\S]{0,400}?text-ink">([+\-−]?[\d,.]+)/);
  const yoyAmount = parseTrendNumber(String(yoyAmountMatch?.[1] || '').replace('−', '-'));
  if (latest && Number.isFinite(yoyAmount)) {
    const previous = latest.value - yoyAmount;
    if (previous > 0) {
      const latestYoy = (yoyAmount / previous) * 100;
      const existingIndex = rows.findIndex((row) => row.date === latest.date);
      const latestRow = { date: latest.date, bokYoy: latestYoy };
      if (existingIndex >= 0) rows[existingIndex] = latestRow;
      else rows.push(latestRow);
    }
  }
  if (!rows.length) throw new Error('KRED BOK asset data not found');
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCentralBankAssetsSeries() {
  const sources = [
    { id: 'WALCL', key: 'fedYoy', rawKey: 'fed', divisor: 1000000 },
    { id: 'BOK_ASSETS', key: 'bokYoy', rawKey: 'bok', divisor: 1, optional: true, custom: fetchKredBokAssetYoyRows },
    { id: 'ECBASSETS', key: 'ecbYoy', rawKey: 'ecb', divisor: 1000000 },
    { id: 'JPNASSETS', key: 'bojYoy', rawKey: 'boj', divisor: 1000000 }
  ];
  const seriesRows = await Promise.all(sources.map(async (source) => {
    if (source.custom) {
      try {
        return await source.custom();
      } catch (_) {
        const fallbackRows = await fetchFredCsvRows('DDDI06KRA156NWDB').catch(() => []);
        return addYearOverYear(monthlyLast(fallbackRows).map((row) => ({
          date: row.date,
          [source.rawKey]: row.value / source.divisor
        })), source.rawKey, source.key);
      }
    }
    const rawRows = await fetchFredCsvRows(source.id).catch((error) => {
      if (source.optional) return [];
      throw error;
    });
    const rows = addYearOverYear(monthlyLast(rawRows).map((row) => ({
      date: row.date,
      [source.rawKey]: row.value / source.divisor
    })), source.rawKey, source.key);
    return rows;
  }));
  const months = new Set(seriesRows.flat().map((row) => row.date.slice(0, 7)));
  const byKey = seriesRows.map((rows) => new Map(rows.map((row) => [row.date.slice(0, 7), row])));
  const series = [...months].sort().map((month) => ({
    date: `${month}-01`,
    fedYoy: byKey[0].get(month)?.fedYoy ?? null,
    bokYoy: byKey[1].get(month)?.bokYoy ?? null,
    ecbYoy: byKey[2].get(month)?.ecbYoy ?? null,
    bojYoy: byKey[3].get(month)?.bojYoy ?? null
  })).filter((row) => [row.fedYoy, row.bokYoy, row.ecbYoy, row.bojYoy].some(Number.isFinite));
  return {
    unit: '%',
    note: '미국·일본·ECB는 FRED, 한국은 KRED의 Bank of Korea Total Assets 공개값을 우선 사용한 전년동월 대비 증가율입니다.',
    series: filterLastYears(series, 10)
  };
}

async function fetchKoreaPrivateBondSeries() {
  const configs = [
    { id: 'DSAMRIAONCKR', key: 'privateDebt', label: '국내 비금융기업 채권 총액' },
    { id: 'DBNLTRIAONCKR', key: 'corporateBond', label: '회사채/장기채권' },
    { id: 'DMMISTRIAONCKR', key: 'commercialPaper', label: '기업어음/단기금융상품' }
  ];
  const rowsBySeries = await Promise.all(configs.map(async (cfg) => ({
    cfg,
    rows: await fetchFredCsvRows(cfg.id)
  })));
  const dates = new Set(rowsBySeries.flatMap((entry) => entry.rows.map((row) => row.date)));
  const maps = rowsBySeries.map((entry) => new Map(entry.rows.map((row) => [row.date, row.value / 1000])));
  const series = [...dates].sort().map((date) => ({
    date,
    privateDebt: maps[0].get(date) ?? null,
    corporateBond: maps[1].get(date) ?? null,
    commercialPaper: maps[2].get(date) ?? null
  })).filter((row) => [row.privateDebt, row.corporateBond, row.commercialPaper].some(Number.isFinite));
  return {
    unit: '십억달러',
    note: 'BIS/FRED 기반 한국 비금융기업 국내채권·단기금융상품 잔액입니다. ABS·여전채 세부선은 무인증 공개 원천 확인 전까지 가짜값으로 대체하지 않습니다.',
    series: filterLastYears(series, 10)
  };
}

async function fetchPrivateCreditGdpSeries() {
  const rows = await fetchFredCsvRows('QKRPAM770A');
  return {
    unit: '%GDP',
    note: 'BIS/FRED 한국 민간 비금융부문 총신용/GDP, 분기 말 기준입니다.',
    series: filterLastYears(rows.map((row) => ({ date: row.date, creditGdp: row.value })), 10)
  };
}

async function fetchKofiaMarketFundsLatest() {
  const html = await fetchTextWithRetries('https://freesis.kofia.or.kr/stat/main.do', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://freesis.kofia.or.kr/'
    }
  }, 3, 'utf-8');

  const extractMetric = (label) => {
    const labelIndex = html.indexOf(`>${label}</a>`);
    if (labelIndex < 0) return null;
    const sectionStart = html.lastIndexOf('<dt', labelIndex);
    if (sectionStart < 0) return null;
    const section = html.slice(sectionStart, sectionStart + 1200);
    const date = stripHtml(section.match(/<span[^>]*class=["']date["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const value = parseTrendNumber(stripHtml(section.match(/<span[^>]*class=["']num1["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''));
    return date && Number.isFinite(value) ? { date, value } : null;
  };

  const deposit = extractMetric('투자자예탁금');
  const credit = extractMetric('신용융자');
  if (!deposit || !credit || deposit.date !== credit.date) return null;
  const dateMatch = deposit.date.match(/^(\d{2})\/(\d{2})$/);
  if (!dateMatch) return null;

  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentYear = nowKst.getUTCFullYear();
  const currentMonth = nowKst.getUTCMonth() + 1;
  const month = Number(dateMatch[1]);
  const year = month > currentMonth + 1 ? currentYear - 1 : currentYear;
  const date = `${year}-${dateMatch[1]}-${dateMatch[2]}`;

  // FreeSIS main indicators are published in KRW millions; charts use KRW trillions.
  return { date, deposit: deposit.value / 1000000, credit: credit.value / 1000000 };
}

async function fetchMarketFundsSeriesFresh(limit = 120) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 120));
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
      if (!dateCell || cells.length < 4) continue;
      const deposit = parseTrendNumber(cells[1]);
      const credit = parseTrendNumber(cells[3]);
      if (!Number.isFinite(deposit) || !Number.isFinite(credit)) continue;
      const [yy, mm, dd] = dateCell.split('.');
      const date = `20${yy}-${mm}-${dd}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, deposit: deposit / 10000, credit: credit / 10000 });
      foundInPage += 1;
    }
    if (!foundInPage && page > 1) break;
    if (rows.length >= safeLimit) break;
  }

  try {
    const officialLatest = await fetchKofiaMarketFundsLatest();
    if (officialLatest) {
      const existingIndex = rows.findIndex((row) => row.date === officialLatest.date);
      if (existingIndex >= 0) rows[existingIndex] = officialLatest;
      else rows.push(officialLatest);
    }
  } catch (error) {
    console.error('Failed to fetch latest market funds from KOFIA', error.message);
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  const selectedRows = rows.slice(-safeLimit);
  let kospiRows = [];
  try {
    kospiRows = (await fetchChartSeries('KOSPI', '1d') || [])
      .filter((row) => row?.date && Number.isFinite(Number(row.close)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  } catch (error) {
    console.error('Failed to fetch KOSPI comparison series for market funds', error.message);
  }
  let kospiIndex = 0;
  let latestKospi = null;
  const series = selectedRows.map((row, index) => {
    const previous = selectedRows[index - 1];
    const creditChange = previous ? row.credit - previous.credit : null;
    const depositChange = previous ? row.deposit - previous.deposit : null;
    while (kospiIndex < kospiRows.length && String(kospiRows[kospiIndex].date).slice(0, 10) <= row.date) {
      latestKospi = Number(kospiRows[kospiIndex].close);
      kospiIndex += 1;
    }
    return {
      ...row,
      kospi: latestKospi,
      creditChange,
      creditChangePercent: previous?.credit ? creditChange / previous.credit * 100 : null,
      depositChange,
      depositChangePercent: previous?.deposit ? depositChange / previous.deposit * 100 : null
    };
  });
  const latest = series[series.length - 1]?.date || '';
  return {
    unit: '조원',
    note: `금융투자협회 최신 공표일(${latest}) 기준, 단위: 조원. KOSPI는 같은 날짜의 종가이며 점선으로 표시합니다.`,
    series
  };
}

async function fetchMarketFundsSeries(limit = 120) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 120));
  const cached = marketFundsCache.get(safeLimit);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  if (marketFundsInFlight.has(safeLimit)) return marketFundsInFlight.get(safeLimit);

  const request = fetchMarketFundsSeriesFresh(safeLimit).then((payload) => {
    if (payload) marketFundsCache.set(safeLimit, { payload, expiresAt: Date.now() + 5 * 60 * 1000 });
    return payload;
  }).finally(() => marketFundsInFlight.delete(safeLimit));
  marketFundsInFlight.set(safeLimit, request);
  return request;
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
  const parseTableRows = (markup) => {
    for (const match of String(markup || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripHtml(cell[1]));
      if (cells.length < 2) continue;
      const date = parseInvestingDate(cells[0]);
      const close = parseTrendNumber(cells[1]);
      if (date && Number.isFinite(close) && close > 0) rows.push({ date, close });
    }
  };
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json?.t) && Array.isArray(json?.c)) {
      for (let index = 0; index < json.t.length; index += 1) {
        const timestamp = Number(json.t[index]);
        const close = Number(json.c[index]);
        if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) continue;
        rows.push({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close });
      }
    }
    if (typeof json?.data === 'string') parseTableRows(json.data);
    const candidates = Array.isArray(json) ? json : (json?.data || json?.series || json?.historicalData || []);
    for (const row of Array.isArray(candidates) ? candidates : []) {
      const rawDate = row?.date || row?.rowDate || row?.rowDateRaw || row?.time || '';
      const date = parseInvestingDate(rawDate) || (/^\d{10,13}$/.test(String(rawDate))
        ? new Date(Number(rawDate) * (String(rawDate).length === 10 ? 1000 : 1)).toISOString().slice(0, 10)
        : '');
      const close = parseTrendNumber(row?.close ?? row?.last_close ?? row?.lastClose ?? row?.price ?? row?.last);
      if (date && Number.isFinite(close) && close > 0) rows.push({ date, close });
    }
  } catch {
    parseTableRows(text);
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

function readVkospiSnapshot(limit) {
  try {
    const file = path.join(ROOT, 'data', 'vkospi.json');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = (Array.isArray(payload?.series) ? payload.series : [])
      .map((row) => ({
        date: String(row?.date || ''),
        open: Number(row?.open),
        high: Number(row?.high),
        low: Number(row?.low),
        close: Number(row?.close)
      }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    return rows.slice(-limit);
  } catch (error) {
    console.error('Failed to read bundled VKOSPI snapshot', error.message);
    return [];
  }
}

async function fetchInvestingVkospi(limit, start, end) {
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Domain-Id': 'www',
    Origin: 'https://www.investing.com',
    Referer: 'https://www.investing.com/indices/kospi-volatility-historical-data'
  };
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const apiUrl = `https://api.investing.com/api/financialdata/historical/956761?start-date=${startDate}&end-date=${endDate}&interval=P1D&time-frame=Daily`;
  const pageUrl = 'https://www.investing.com/indices/kospi-volatility-historical-data';
  const chartFrom = Math.floor(start.getTime() / 1000);
  const chartTo = Math.floor(end.getTime() / 1000) + 86400;
  const chartUrl = `https://tvc6.investing.com/d8f62270e64f9eb6e4e6a07c3ffeab0b/1729428526/9/9/16/history?symbol=956761&resolution=D&from=${chartFrom}&to=${chartTo}`;
  const urls = [
    chartUrl,
    `https://r.jina.ai/http://${chartUrl.replace(/^https?:\/\//, '')}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(chartUrl)}`,
    apiUrl,
    pageUrl,
    `https://r.jina.ai/http://${apiUrl.replace(/^https?:\/\//, '')}`,
    `https://r.jina.ai/http://${pageUrl.replace(/^https?:\/\//, '')}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(pageUrl)}`
  ];
  const attempts = await Promise.allSettled(urls.map(async (url) => {
    const chartRequest = url === chartUrl;
    const requestHeaders = chartRequest
      ? { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
      : headers;
    const r = await fetchWithTimeout(url, { headers: requestHeaders }, 15000);
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
              open: Number(values[1]),
              high: Number(values[2]),
              low: Number(values[3]),
              close: Number(values[4])
            };
          }).filter((row) => row.date && [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.close > 0);
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

async function fetchVkospiSeries(limit = 120) {
  const safeLimit = Math.max(20, Math.min(500, Number(limit) || 120));
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(300, safeLimit * 2));
  const snapshotRows = readVkospiSnapshot(safeLimit);
  const snapshotLatest = snapshotRows[snapshotRows.length - 1]?.date || '';
  const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let krxRows = [];
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
      const rawOpen = row.OPNPRC_IDX || row.OPN_IDX || row.open || row.시가 || row.OPNPRC || '';
      const rawHigh = row.HGPRC_IDX || row.HIG_IDX || row.high || row.고가 || row.HGPRC || '';
      const rawLow = row.LWPRC_IDX || row.LOW_IDX || row.low || row.저가 || row.LWPRC || '';
      const rawClose = row.CLSPRC_IDX || row.CLS_IDX || row.close || row.종가 || row.CLSPRC || row.clsprcIdx || '';
      const date = String(rawDate).replace(/\./g, '-').replace(/\//g, '-').replace(/\s+/g, '');
      const open = parseTrendNumber(rawOpen);
      const high = parseTrendNumber(rawHigh);
      const low = parseTrendNumber(rawLow);
      const close = parseTrendNumber(rawClose);
      return { date, open, high, low, close };
    }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.close > 0);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length) {
      krxRows = rows.slice(-safeLimit);
      const latest = rows[rows.length - 1]?.date || '';
      if (latest === todayKst) {
        return { unit: 'P', note: `KRX V-KOSPI 200 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`, series: krxRows };
      }
    }
  } catch (e) {
    console.error('Failed to fetch VKOSPI from KRX', e);
  }
  const [investingRows, tradingViewResult] = await Promise.all([
    fetchInvestingVkospi(safeLimit, start, end),
    fetchTradingViewVkospi(safeLimit)
  ]);
  const sourceCandidates = [
    { source: 'krx', priority: 3, rows: krxRows },
    { source: 'snapshot', priority: 2.5, rows: snapshotRows },
    { source: 'investing', priority: 2, rows: investingRows },
    { source: 'tradingview', priority: 1, rows: tradingViewResult.rows }
  ].filter((candidate) => candidate.rows.length);
  const hasOhlc = (candidate) => candidate.rows.some((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite));
  sourceCandidates.sort((a, b) => {
    const ohlcDifference = Number(hasOhlc(b)) - Number(hasOhlc(a));
    if (ohlcDifference) return ohlcDifference;
    const dateA = a.rows[a.rows.length - 1]?.date || '';
    const dateB = b.rows[b.rows.length - 1]?.date || '';
    return dateB.localeCompare(dateA) || b.priority - a.priority;
  });
  const selected = sourceCandidates[0];
  if (selected) {
    const latest = selected.rows[selected.rows.length - 1]?.date || '';
    if (selected.source === 'krx') {
      return { unit: 'P', note: `KRX V-KOSPI 200 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`, series: selected.rows };
    }
    if (selected.source === 'investing') {
      return {
        unit: 'P',
        note: `Investing.com KOSPI Volatility(KSVKOSPI) 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`,
        series: selected.rows
      };
    }
    if (selected.source === 'snapshot') {
      return {
        unit: 'P',
        note: hasOhlc(selected)
          ? `KRX V-KOSPI 200 선물 연속계약(VKI1!) 실제 일봉 스냅샷입니다. 최신 거래일(${latest}) 기준입니다.`
          : `VKOSPI 현물 최신 거래일(${latest}) 기준입니다. 휴장일에는 직전 거래일 기준으로 표시합니다.`,
        series: selected.rows
      };
    }
    return {
      unit: 'P',
      note: `VKOSPI 현물 공개 원천 차단으로 KRX V-KOSPI 200 선물 연속계약(VKI1!) 실제 일봉을 표시합니다. 최신 거래일(${latest}) 기준입니다.`,
      series: selected.rows
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
      const quotes = result?.indicators?.quote?.[0] || {};
      const rows = [];
      for (let i = 0; i < ts.length; i += 1) {
        const open = Number(quotes.open?.[i]);
        const high = Number(quotes.high?.[i]);
        const low = Number(quotes.low?.[i]);
        const close = Number(closes[i]);
        if (![open, high, low, close].every(Number.isFinite) || close <= 0) continue;
        rows.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open, high, low, close });
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
  const unified = await fetchUnifiedSeries(key, interval).catch(() => null);
  if (unified && unified.length) return unified;
  if (key === 'US10Y') {
    const rows = await supplementTreasuryYield(await fetchFredYieldSeries('DGS10', 0.2), 'BC_10YEAR');
    if (!rows.length) return null;
    return rows.slice(-260);
  }
  if (key === 'US2Y') {
    const rows = await supplementTreasuryYield(await fetchFredYieldSeries('DGS2', 0.1), 'BC_2YEAR');
    if (!rows.length) return null;
    return rows.slice(-260);
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
    return rows.slice(-260);
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
    return rows.slice(-260);
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
    return rows.slice(-260);
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
    return rows.slice(-260);
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
    return rows.slice(-260);
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
    return rows.slice(-260);
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
        const naverCode = key === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
        const naverResponse = await fetch(`https://m.stock.naver.com/api/index/${naverCode}/price?pageSize=10&page=1`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const naverRows = await naverResponse.json();
        if (Array.isArray(naverRows)) {
          naverRows.forEach((row) => {
            const naverDate = String(row.localTradedAt || row.localTradedDate || '').slice(0, 10);
            const naverClose = Number(String(row.closePrice || '').replace(/,/g, ''));
            if (naverDate && Number.isFinite(naverClose) && naverClose > 0) dailyCloses[naverDate] = naverClose;
          });
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
    if ((key === 'KOSPI' || key === 'KOSDAQ') && targetMin > 0 && rows.length) {
      const latestDate = new Date(Number(rows[rows.length - 1].date) * 1000).toISOString().slice(0, 10);
      const closingRows = await fetchNaverIndexClosingMinutes(key, latestDate, targetMin).catch(() => []);
      if (closingRows.length) {
        const merged = new Map(rows.map((row) => [Number(row.date), row]));
        closingRows.forEach((row) => merged.set(Number(row.date), row));
        rows.length = 0;
        rows.push(...[...merged.values()].sort((a, b) => Number(a.date) - Number(b.date)));
      }
    }
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
  const requestPath = normalizeApiPath(u.pathname);

  if (requestPath === '/api/quote') {
    try {
      const symbol = u.searchParams.get('symbol') || '';
      const q = await fetchStooq(symbol);
      if (!q) return send(res, 404, JSON.stringify({ ok: false, error: 'no data' }), 'application/json');
      return send(res, 200, JSON.stringify({ ok: true, quote: q }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/bond-yields') {
    try {
      const rows = await fetchBondYields();
      return send(res, 200, JSON.stringify({ ok: true, rows }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/high-breakouts') {
    try {
      const payload = await fetchHighBreakouts();
      return send(res, 200, JSON.stringify({ ok: true, ...payload }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/dashboard-panels') {
    try {
      const payload = await fetchDashboardPanels(u.searchParams.get('watchlist') || '', u.searchParams.get('refresh') === '1');
      return send(res, 200, JSON.stringify({ ok: true, ...payload }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/binance-korea-futures') {
    try {
      const rows = await fetchBinanceKoreaFutures();
      return send(res, 200, JSON.stringify({ ok: true, asOf: new Date().toISOString(), rows }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/investor-top-flows') {
    try {
      const payload = await fetchInvestorTopFlows(null, u.searchParams.get('refresh') === '1');
      return send(res, 200, JSON.stringify({ ok: true, ...payload }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/chart') {
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
  if (requestPath === '/api/extra-chart') {
    try {
      const kind = u.searchParams.get('kind') || '';
      const days = Number(u.searchParams.get('days') || 120);
      let payload = null;
      if (kind === 'kospi-investor-daily') payload = await fetchInvestorSeries('KOSPI', 'daily', days);
      if (kind === 'kospi-investor-minute') payload = await fetchInvestorSeries('KOSPI', 'minute', days);
      if (kind === 'kosdaq-investor-daily') payload = await fetchInvestorSeries('KOSDAQ', 'daily', days);
      if (kind === 'kosdaq-investor-minute') payload = await fetchInvestorSeries('KOSDAQ', 'minute', days);
      if (kind === 'market-funds') payload = await fetchMarketFundsSeries(days);
      if (kind === 'vkospi') payload = await fetchVkospiSeries(days);
      if (kind === 'foreign-futures-daily') payload = await fetchForeignFuturesSeries(days);
      if (kind === 'foreign-futures-minute') payload = await fetchForeignFuturesMinuteSeries();
      if (kind === 'kospi-futures-minute') payload = await fetchPriceMinuteSeries('KOSPI_FUTURES', 'KOSPI200 선물', 'P');
      if (kind === 'usdkrw-minute') payload = await fetchPriceMinuteSeries('USDKRW', '원/달러', '원');
      if (kind === 'market-turnover-daily') payload = await fetchMarketTurnoverSeries(days);
      if (kind === 'm2-trend') payload = await fetchM2TrendSeries();
      if (kind === 'us-m2-trend') payload = await fetchUsM2TrendSeries();
      if (kind === 'central-bank-assets') payload = await fetchCentralBankAssetsSeries();
      if (kind === 'korea-private-bonds') payload = await fetchKoreaPrivateBondSeries();
      if (kind === 'private-credit-gdp') payload = await fetchPrivateCreditGdpSeries();
      if (!payload) return send(res, 404, JSON.stringify({ ok: false, error: 'no data' }), 'application/json');
      if (payload.unavailable) return send(res, 404, JSON.stringify({ ok: false, error: payload.error }), 'application/json');
      return send(res, 200, JSON.stringify({ ok: true, ...payload }), 'application/json');
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }), 'application/json');
    }
  }
  if (requestPath === '/api/stats') {
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

  const target = resolveStaticPath(u.pathname);
  const file = path.join(ROOT, target);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml; charset=utf-8'
  };
  const type = types[ext] || 'text/plain; charset=utf-8';
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
  fetchForeignFuturesMinuteSeries,
  fetchPriceMinuteSeries,
  fetchMarketTurnoverSeries,
  fetchM2TrendSeries,
  fetchUsM2TrendSeries,
  fetchCentralBankAssetsSeries,
  fetchKoreaPrivateBondSeries,
  fetchPrivateCreditGdpSeries
};
