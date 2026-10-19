// api/stats.js
// Vercel serverless function for the two dashboard tables:
// 1) 외국인 수급 / 프로그램
// 2) 시장 거래대금

const { fetchForeignFuturesSeries } = require('../server');
const { futuresStats, sumWindows, nullableArray } = require('../flow-stats');

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toEokWon(value) {
  return Math.round(numberOrZero(value) / 100000000);
}

function formatNumber(value) {
  return Math.round(numberOrZero(value)).toLocaleString('ko-KR');
}

function pctChange(current, previous) {
  const c = numberOrZero(current);
  const p = numberOrZero(previous);
  if (!p) return '0';
  const percent = ((c - p) / p) * 100;
  return Math.abs(percent) < 0.005 ? '0' : percent.toFixed(2);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://finance.daum.net/',
        'Origin': 'https://finance.daum.net',
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDaumMarketDays(market, perPage) {
  const url = `https://finance.daum.net/api/market_index/days?page=1&perPage=${perPage}&market=${market}&pagination=true`;
  const text = await fetchWithTimeout(url);

  try {
    const json = JSON.parse(text);
    return Array.isArray(json.data) ? json.data : [];
  } catch (error) {
    throw new Error(`Daum returned non-JSON for ${market}: ${text.slice(0, 120)}`);
  }
}

function decodeKorean(buffer) {
  try {
    return new TextDecoder('euc-kr').decode(buffer);
  } catch (_) {
    try {
      return Buffer.from(buffer).toString('utf8');
    } catch (__) {
      return '';
    }
  }
}

async function fetchProgramTradingDays(limit = 20) {
  const safeLimit = Math.max(20, Math.min(200, Number(limit) || 20));
  const rows = [];
  const seen = new Set();
  const bizdate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const maxPages = Math.ceil(safeLimit / 10) + 3;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://finance.naver.com/sise/programDealTrendDay.naver?bizdate=${bizdate}&sosok=&page=${page}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,*/*',
        Referer: 'https://finance.naver.com/sise/sise_program.naver'
      }
    });
    if (!response.ok) throw new Error(`Naver program HTTP ${response.status}`);
    const html = decodeKorean(await response.arrayBuffer());
    const tableRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let foundInPage = 0;

    for (const match of tableRows) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => String(cell[1] || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim());
      if (cells.length < 10 || !/^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) continue;
      const net = Number(cells[9].replace(/,/g, ''));
      if (!Number.isFinite(net)) continue;
      const [yy, mm, dd] = cells[0].split('.');
      const date = `20${yy}-${mm}-${dd}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, net });
      foundInPage += 1;
    }

    if (!foundInPage && page > 1) break;
    if (rows.length >= safeLimit) break;
  }

  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, safeLimit);
}

module.exports = async function handler(req, res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  try {
    const results = await Promise.allSettled([
      fetchDaumMarketDays('KOSPI', 20),
      fetchDaumMarketDays('KOSDAQ', 20),
      fetchProgramTradingDays(20),
      fetchForeignFuturesSeries(20)
    ]);
    const value = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
    const kospiData = value(0, []);
    const kosdaqData = value(1, []);
    const programRows = value(2, []);
    const futuresPayload = value(3, null);

    const kospiToday = kospiData[0] || {};
    const kospiPrev = kospiData[1] || {};
    const kosdaqToday = kosdaqData[0] || {};
    const kosdaqPrev = kosdaqData[1] || {};

    const kospiTurnover = numberOrZero(kospiToday.accTradePrice);
    const kosdaqTurnover = numberOrZero(kosdaqToday.accTradePrice);

    const flowSummary = futuresStats(futuresPayload);
    const progsArray = nullableArray(sumWindows(programRows.map((row) => ({ date: row.date, value: row.net }))));
    const programSource = progsArray ? 'Naver Finance programDealTrendDay' : 'unavailable';

    return sendJson(res, 200, {
      ok: true,

      // index.html displays "백만", so keep Daum's original accTradePrice unit.
      kospiTurnover: formatNumber(kospiTurnover),
      kosdaqTurnover: formatNumber(kosdaqTurnover),

      // index.html appends "%", so return real percentage changes.
      kospiTurnoverDiff: pctChange(kospiToday.accTradePrice, kospiPrev.accTradePrice),
      kosdaqTurnoverDiff: pctChange(kosdaqToday.accTradePrice, kosdaqPrev.accTradePrice),

      ...flowSummary,
      progsArray,
      programSource,
      latestOpenDate: String(futuresPayload?.series?.at(-1)?.date || kospiData[0]?.date || '').slice(0, 10),

      asOf: new Date().toISOString(),
      source: {
        turnover: 'Daum Finance market_index/days',
        foreignFlow: flowSummary.futuresArray === null ? 'unavailable' : flowSummary.futuresMode === 'spot-fallback' ? 'Daum Finance KOSPI foreign spot fallback, 억원' : 'Naver Finance futures investorDealTrendDay, sosok=03, contracts',
        program: programSource,
        programAsOf: programRows[0]?.date || null
      }
    });
  } catch (error) {
    // Preserve missing flow data instead of presenting failures as real zeroes.
    return sendJson(res, 200, {
      ok: true,
      kospiTurnover: '0',
      kosdaqTurnover: '0',
      kospiTurnoverDiff: '0.00',
      kosdaqTurnoverDiff: '0.00',
      futuresArray: null,
      futuresMode: 'futures',
      futuresUnit: '계약',
      progsArray: null,
      programSource: 'unavailable',
      asOf: new Date().toISOString(),
      warning: String(error.message || error)
    });
  }
};
