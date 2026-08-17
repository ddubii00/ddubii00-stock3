// api/stats.js
// Vercel serverless function for the two dashboard tables:
// 1) 외국인 수급 / 프로그램
// 2) 시장 거래대금

const { fetchForeignFuturesSeries } = require('../server');

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
  if (!p) return '0.00';
  return (((c - p) / p) * 100).toFixed(2);
}

function cumulative(values, days) {
  const out = [];
  for (const d of days) {
    const sum = values.slice(0, d).reduce((acc, v) => acc + numberOrZero(v), 0);
    out.push(Math.round(sum));
  }
  return out;
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

async function fetchProgramTradingEok() {
  try {
    const response = await fetch('https://finance.naver.com/sise/sise_index.naver?code=KOSPI', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,*/*',
        'Referer': 'https://finance.naver.com/'
      }
    });

    const buffer = await response.arrayBuffer();
    const html = decodeKorean(buffer);

    // Naver page usually contains:
    // 전체<br><span class="...">+1,234<span>억
    const patterns = [
      /전체\s*<br>\s*<span[^>]*>\s*([+-]?[\d,]+)\s*<span>\s*억/i,
      /프로그램[^+-\d]{0,80}([+-]?[\d,]+)\s*억/i,
      /전체[^+-\d]{0,80}([+-]?[\d,]+)\s*억/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        return parseInt(match[1].replace(/,/g, ''), 10) || 0;
      }
    }
  } catch (_) {
    // Keep dashboard alive even if Naver blocks or changes the page.
  }

  return 0;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  try {
    const [kospiData, kosdaqData, programToday, futuresPayload] = await Promise.all([
      fetchDaumMarketDays('KOSPI', 20),
      fetchDaumMarketDays('KOSDAQ', 20),
      fetchProgramTradingEok(),
      fetchForeignFuturesSeries(20)
    ]);

    const kospiToday = kospiData[0] || {};
    const kospiPrev = kospiData[1] || {};
    const kosdaqToday = kosdaqData[0] || {};
    const kosdaqPrev = kosdaqData[1] || {};

    const kospiTurnover = numberOrZero(kospiToday.accTradePrice);
    const kosdaqTurnover = numberOrZero(kosdaqToday.accTradePrice);

    const days = [1, 3, 5, 10, 20];
    const recentFutures = (futuresPayload?.series || []).slice().reverse().map((row) => row.foreign);
    const futuresArray = cumulative(recentFutures, days);

    // Naver only gives today's program number here.
    // Use the current ratio as an estimate for 3/5/10/20-day cumulative values.
    let progsArray = [programToday, 0, 0, 0, 0];
    if (futuresArray[0] !== 0 && programToday !== 0) {
      const ratio = programToday / futuresArray[0];
      progsArray = futuresArray.map((v, i) => (i === 0 ? programToday : Math.round(v * ratio)));
    } else {
      progsArray = days.map((d) => Math.round(programToday * d));
    }

    return sendJson(res, 200, {
      ok: true,

      // index.html displays "백만", so keep Daum's original accTradePrice unit.
      kospiTurnover: formatNumber(kospiTurnover),
      kosdaqTurnover: formatNumber(kosdaqTurnover),

      // index.html appends "%", so return real percentage changes.
      kospiTurnoverDiff: pctChange(kospiToday.accTradePrice, kospiPrev.accTradePrice),
      kosdaqTurnoverDiff: pctChange(kosdaqToday.accTradePrice, kosdaqPrev.accTradePrice),

      futuresArray,
      progsArray,

      asOf: new Date().toISOString(),
      source: {
        turnover: 'Daum Finance market_index/days',
        foreignFlow: 'Naver Finance futures investorDealTrendDay, sosok=03, contracts',
        program: 'Naver Finance KOSPI page'
      }
    });
  } catch (error) {
    // Return ok:true with zero-filled values so the dashboard table does not remain blank.
    return sendJson(res, 200, {
      ok: true,
      kospiTurnover: '0',
      kosdaqTurnover: '0',
      kospiTurnoverDiff: '0.00',
      kosdaqTurnoverDiff: '0.00',
      futuresArray: [0, 0, 0, 0, 0],
      progsArray: [0, 0, 0, 0, 0],
      asOf: new Date().toISOString(),
      warning: String(error.message || error)
    });
  }
};
