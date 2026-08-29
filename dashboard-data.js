'use strict';

const { fetchHighBreakouts } = require('./breakout-data');

const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_WATCHLIST = [
  { name: '한화에어로스페이스', code: '012450', market: 'KR' },
  { name: 'LIG넥스원', code: '079550', market: 'KR' },
  { name: 'SK하이닉스', code: '000660', market: 'KR' },
  { name: '삼성전자', code: '005930', market: 'KR' },
  { name: 'NVIDIA', code: 'NVDA', market: 'US' },
  { name: 'Palantir', code: 'PLTR', market: 'US' },
  { name: 'TSMC', code: 'TSM', market: 'US' }
];

const SECTORS = [
  { name: '반도체', codes: ['005930', '000660', '042700', '403870', '108320'] },
  { name: '자동차', codes: ['005380', '000270', '012330', '161390', '086280'] },
  { name: '2차전지', codes: ['373220', '006400', '051910', '247540', '096770'] },
  { name: '방산', codes: ['012450', '079550', '047810', '064350', '272210'] },
  { name: '조선', codes: ['009540', '329180', '042660', '010140', '010620'] },
  { name: '바이오', codes: ['207940', '068270', '128940', '196170', '145020'] },
  { name: '인터넷', codes: ['035420', '035720', '181710', '402340', '058970'] },
  { name: '게임', codes: ['259960', '036570', '251270', '293490', '263750'] },
  { name: '은행', codes: ['105560', '055550', '316140', '086790', '024110'] },
  { name: '증권', codes: ['005940', '016360', '039490', '006800', '030210'] },
  { name: '보험', codes: ['000810', '032830', '005830', '088350', '001450'] },
  { name: '철강', codes: ['005490', '004020', '010130', '001430', '058650'] },
  { name: '화학', codes: ['051910', '011170', '009830', '002380', '298050'] },
  { name: '건설', codes: ['000720', '047040', '028050', '006360', '375500'] },
  { name: '유통', codes: ['139480', '004170', '023530', '007070', '282330'] },
  { name: '통신', codes: ['017670', '030200', '032640'] },
  { name: '엔터', codes: ['352820', '041510', '122870', '035900', '376300'] },
  { name: '로봇', codes: ['277810', '454910', '108490', '090360', '064480'] },
  { name: '원전·전력', codes: ['034020', '015760', '051600', '010120', '298040'] },
  { name: '항공·운송', codes: ['003490', '086280', '011200', '028670', '180640'] }
];

const WATCHLIST_ALIASES = new Map(DEFAULT_WATCHLIST.flatMap((item) => [
  [item.code.toLowerCase(), item],
  [item.name.toLowerCase(), item]
]));

const ECONOMIC_EVENTS = [
  { date: '2026-09-10', name: '미국 PPI', source: 'BLS', importance: 'high' },
  { date: '2026-09-11', name: '미국 CPI', source: 'BLS', importance: 'high' },
  { date: '2026-09-16', name: 'FOMC 금리결정', source: 'Federal Reserve', importance: 'critical' },
  { date: '2026-10-14', name: '미국 CPI', source: 'BLS', importance: 'high' },
  { date: '2026-10-15', name: '미국 PPI', source: 'BLS', importance: 'high' },
  { date: '2026-10-22', name: '한국은행 금통위', source: '한국은행', importance: 'critical' },
  { date: '2026-10-28', name: 'FOMC 금리결정', source: 'Federal Reserve', importance: 'critical' },
  { date: '2026-11-10', name: '미국 CPI', source: 'BLS', importance: 'high' },
  { date: '2026-11-13', name: '미국 PPI', source: 'BLS', importance: 'high' },
  { date: '2026-11-26', name: '한국은행 금통위', source: '한국은행', importance: 'critical' },
  { date: '2026-12-09', name: 'FOMC 금리결정', source: 'Federal Reserve', importance: 'critical' },
  { date: '2026-12-10', name: '미국 CPI', source: 'BLS', importance: 'high' }
];

const cache = new Map();
const inFlight = new Map();
let marketUniverseCache = null;
let marketUniverseInFlight = null;

function normalizeWatchlist(input) {
  const tokens = Array.isArray(input)
    ? input
    : String(input || '').split(/[\n,]+/).map((token) => token.trim()).filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const tokenValue of tokens.length ? tokens : DEFAULT_WATCHLIST.map((item) => item.code)) {
    const token = String(tokenValue).trim();
    const separator = token.lastIndexOf(':');
    const suppliedName = separator > 0 ? token.slice(0, separator).trim() : '';
    const rawCode = separator > 0 ? token.slice(separator + 1).trim() : token;
    const alias = WATCHLIST_ALIASES.get(rawCode.toLowerCase()) || WATCHLIST_ALIASES.get(token.toLowerCase());
    const code = String(alias?.code || rawCode).toUpperCase();
    if (!/^\d{6}$/.test(code) && !/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    rows.push({
      name: suppliedName || alias?.name || code,
      code,
      market: /^\d{6}$/.test(code) ? 'KR' : 'US'
    });
    if (rows.length >= 20) break;
  }
  return rows.length ? rows : DEFAULT_WATCHLIST;
}

function number(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').replace(/%/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function signedNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/%/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatYmd(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarketUniverse() {
  if (marketUniverseCache && marketUniverseCache.expiresAt > Date.now()) return marketUniverseCache.rows;
  if (marketUniverseInFlight) return marketUniverseInFlight;
  marketUniverseInFlight = (async () => {
    const fetchMarket = async (marketType) => {
      const params = new URLSearchParams({
        tradeType: 'KRX',
        marketType,
        orderType: 'marketSum',
        startIdx: '0',
        pageSize: '2500'
      });
      const json = await fetchJson(`https://stock.naver.com/api/domestic/market/stock/default?${params}`, {
        headers: { Referer: 'https://stock.naver.com/' }
      });
      return Array.isArray(json) ? json.map((row) => ({ ...row, marketType })) : [];
    };
    const rows = (await Promise.all([fetchMarket('KOSPI'), fetchMarket('KOSDAQ')])).flat();
    const mapped = rows.map((row) => ({
      code: row.itemcode,
      name: row.itemname,
      marketType: row.marketType,
      marketCap: number(row.marketSum),
      listedStockCnt: number(row.listedStockCnt),
      price: signedNumber(row.nowPrice),
      changeRate: signedNumber(row.prevChangeRate),
      volume: signedNumber(row.tradeVolume),
      tradeAmount: signedNumber(row.tradeAmount),
      asOf: String(row.tradableStatusUpdatedAt || '').slice(0, 10)
    })).filter((row) => /^\d{6}$/.test(row.code));
    marketUniverseCache = { rows: mapped, expiresAt: Date.now() + 5 * 60 * 1000 };
    return mapped;
  })().finally(() => { marketUniverseInFlight = null; });
  return marketUniverseInFlight;
}

async function fetchKoreanSnapshot(code, name = '', marketRow = null) {
  const base = 'https://m.stock.naver.com';
  const [basic, prices, trend] = await Promise.all([
    fetchJson(`${base}/api/stock/${code}/basic`, { headers: { Referer: 'https://stock.naver.com/' } }),
    fetchJson(`${base}/api/stock/${code}/price?pageSize=21&page=1`, { headers: { Referer: 'https://stock.naver.com/' } }),
    fetchJson(`${base}/front-api/stock/domestic/trend?code=${code}`, { headers: { Referer: 'https://stock.naver.com/' } }).catch(() => null)
  ]);
  const rows = Array.isArray(prices) ? prices : [];
  const currentVolume = number(rows[0]?.accumulatedTradingVolume) ?? marketRow?.volume ?? null;
  const previousVolumes = rows.slice(1, 21).map((row) => number(row.accumulatedTradingVolume)).filter((value) => value > 0);
  const averageVolume20 = previousVolumes.length ? previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length : null;
  const latestTrend = Array.isArray(trend?.result) ? trend.result[0] : null;
  const close = signedNumber(basic.closePrice) ?? signedNumber(rows[0]?.closePrice) ?? marketRow?.price ?? null;
  const resolvedName = name && name !== code ? name : (basic.stockName || basic.itemName || marketRow?.name || code);
  return {
    name: resolvedName,
    code,
    market: 'KR',
    price: close,
    changeRate: signedNumber(basic.fluctuationsRatio) ?? signedNumber(rows[0]?.fluctuationsRatio) ?? marketRow?.changeRate ?? null,
    volume: currentVolume,
    volumeRatio: currentVolume && averageVolume20 ? currentVolume / averageVolume20 : null,
    asOf: String(basic.localTradedAt || rows[0]?.localTradedAt || marketRow?.asOf || '').slice(0, 10),
    foreignValue: close && latestTrend ? (signedNumber(latestTrend.foreignerPureBuyQuant) || 0) * close : null,
    institutionValue: close && latestTrend ? (signedNumber(latestTrend.organPureBuyQuant) || 0) * close : null,
    marketCap: marketRow?.marketCap ?? null,
    listedStockCnt: marketRow?.listedStockCnt ?? null,
    source: 'Naver Stock/Koscom'
  };
}

async function fetchUsSnapshot(symbol, name) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const json = await fetchJson(url, { headers: { Referer: 'https://finance.yahoo.com/' } });
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const rows = timestamps.map((timestamp, index) => ({
    timestamp,
    close: signedNumber(quote.close?.[index]),
    volume: signedNumber(quote.volume?.[index])
  })).filter((row) => row.close !== null);
  const last = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const previousVolumes = rows.slice(-21, -1).map((row) => row.volume).filter((value) => value > 0);
  const averageVolume20 = previousVolumes.length ? previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length : null;
  return {
    name,
    code: symbol,
    market: 'US',
    price: last?.close ?? null,
    changeRate: last?.close && previous?.close ? ((last.close - previous.close) / previous.close) * 100 : null,
    volume: last?.volume ?? null,
    volumeRatio: last?.volume && averageVolume20 ? last.volume / averageVolume20 : null,
    asOf: last?.timestamp ? new Date(last.timestamp * 1000).toISOString().slice(0, 10) : '',
    source: 'Yahoo Finance'
  };
}

async function fetchDisclosureRows(watchlist) {
  const korean = watchlist.filter((item) => item.market === 'KR');
  const results = await Promise.all(korean.map(async (item) => {
    try {
      const [disclosureJson, newsJson] = await Promise.all([
        fetchJson(`https://m.stock.naver.com/front-api/stock/domestic/disclosure?code=${item.code}&page=1&pageSize=5`, { headers: { Referer: 'https://stock.naver.com/' } }),
        fetchJson(`https://m.stock.naver.com/front-api/news/list/integration?itemCode=${item.code}&page=1&pageSize=5`, { headers: { Referer: 'https://stock.naver.com/' } }).catch(() => null)
      ]);
      const disclosures = (Array.isArray(disclosureJson?.result) ? disclosureJson.result : []).map((row) => ({
        code: item.code,
        name: item.name,
        type: '공시',
        title: row.title || '',
        datetime: row.datetime || '',
        author: row.author || '',
        url: `https://stock.naver.com/domestic/stock/${item.code}/disclosure`
      }));
      const news = (Array.isArray(newsJson?.result?.stockNewsList) ? newsJson.result.stockNewsList : []).map((row) => ({
        code: item.code,
        name: item.name,
        type: '뉴스',
        title: row.titleFull || row.title || '',
        datetime: String(row.datetime || '').replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2}).*$/, '$1-$2-$3T$4:$5:00'),
        author: row.officeName || '',
        url: row.mobileNewsUrl || `https://stock.naver.com/domestic/stock/${item.code}/news`
      }));
      return [...disclosures, ...news];
    } catch {
      return [];
    }
  }));
  const rows = results.flat();
  const byNewest = (a, b) => b.datetime.localeCompare(a.datetime);
  const disclosures = rows.filter((row) => row.type === '공시').sort(byNewest).slice(0, 8);
  const news = rows.filter((row) => row.type === '뉴스').sort(byNewest).slice(0, 8);
  return [...disclosures, ...news].sort(byNewest);
}

async function fetchSectorRows(snapshotByCode, marketByCode) {
  const pending = new Map();
  const getSnapshot = (code) => {
    if (snapshotByCode.has(code)) return Promise.resolve(snapshotByCode.get(code));
    if (!pending.has(code)) {
      pending.set(code, fetchKoreanSnapshot(code, '', marketByCode.get(code)).then((snapshot) => {
        snapshotByCode.set(code, snapshot);
        return snapshot;
      }).catch(() => null));
    }
    return pending.get(code);
  };
  const rows = await Promise.all(SECTORS.map(async (sector) => {
    const snapshots = await Promise.all(sector.codes.map(getSnapshot));
    const valid = snapshots.filter(Boolean).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 5);
    const marketCap = valid.reduce((sum, row) => sum + (Number.isFinite(row.marketCap) ? row.marketCap : 0), 0);
    const weightedSum = valid.reduce((sum, row) => sum + (Number.isFinite(row.changeRate) && Number.isFinite(row.marketCap) ? row.changeRate * row.marketCap : 0), 0);
    const rates = valid.map((row) => row.changeRate).filter(Number.isFinite);
    const changeRate = marketCap > 0 && weightedSum !== 0 ? weightedSum / marketCap : (rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null);
    const upCount = valid.filter((row) => Number(row.changeRate) > 0).length;
    return {
      name: sector.name,
      changeRate,
      foreignValue: valid.reduce((sum, row) => sum + (Number.isFinite(row.foreignValue) ? row.foreignValue : 0), 0),
      institutionValue: valid.reduce((sum, row) => sum + (Number.isFinite(row.institutionValue) ? row.institutionValue : 0), 0),
      marketCap,
      upRatio: valid.length ? (upCount / valid.length) * 100 : null,
      covered: valid.length,
      total: sector.codes.length,
      stocks: valid.map((row) => ({
        name: row.name,
        code: row.code,
        price: row.price,
        changeRate: row.changeRate,
        volumeRatio: row.volumeRatio,
        foreignValue: row.foreignValue,
        institutionValue: row.institutionValue,
        marketCap: row.marketCap,
        asOf: row.asOf,
        url: `https://stock.naver.com/domestic/stock/${row.code}/price`
      })),
      method: '대표종목 시가총액 가중 등락률·순매수 추정 합계'
    };
  }));
  return rows.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 20);
}

function buildCalendar() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return ECONOMIC_EVENTS.map((event) => {
    const eventDate = new Date(`${event.date}T00:00:00+09:00`);
    return { ...event, daysLeft: Math.ceil((eventDate - today) / 86400000) };
  }).filter((event) => event.daysLeft >= 0).slice(0, 20);
}

async function fetchStooqRows(symbol) {
  const response = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const lines = String(await response.text()).trim().split('\n').slice(1);
  return lines.map((line) => {
    const columns = line.split(',');
    return { asOf: columns[0], close: signedNumber(columns[4]) };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.asOf) && Number.isFinite(row.close) && row.close > 0);
}

async function fetchYahooRows(symbol) {
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`, {
    headers: { Referer: 'https://finance.yahoo.com/' }
  });
  const result = json?.chart?.result?.[0] || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  return timestamps.map((timestamp, index) => ({
    asOf: new Date(timestamp * 1000).toISOString().slice(0, 10),
    close: signedNumber(closes[index])
  })).filter((row) => Number.isFinite(row.close) && row.close > 0);
}

async function fetchMarketRows(symbol) {
  const stooqSymbols = { '^VIX': '^vix', '^SOX': '^sox', 'KRW=X': 'usdkrw', US10Y: '10us.b', US2Y: '2us.b' };
  const yahooRows = symbol.startsWith('^') || symbol.endsWith('=X') ? await fetchYahooRows(symbol).catch(() => []) : [];
  if (yahooRows.length >= 5) return yahooRows;
  return fetchStooqRows(stooqSymbols[symbol] || symbol).catch(() => yahooRows);
}

async function fetchDaumMarketRows(market = 'KOSPI', perPage = 10) {
  const json = await fetchJson(`https://finance.daum.net/api/market_index/days?page=1&perPage=${perPage}&market=${market}&pagination=true`, {
    headers: { Referer: 'https://finance.daum.net/' }
  });
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.reverse().map((row) => ({
    date: String(row.date || '').slice(0, 10),
    close: signedNumber(row.tradePrice),
    turnover: signedNumber(row.accTradePrice),
    foreign: signedNumber(row.foreignStraightPurchasePrice),
    institution: signedNumber(row.institutionStraightPurchasePrice)
  })).filter((row) => row.date);
}

async function fetchForeignFuturesRows(limit = 20) {
  const safeLimit = Math.max(5, Math.min(60, Number(limit) || 20));
  const rows = [];
  const seen = new Set();
  const bizdate = formatYmd(new Date());
  const maxPages = Math.ceil(safeLimit / 10) + 5;
  for (let page = 1; page <= maxPages; page += 1) {
    const html = await fetchText(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=03&page=${page}`, {
      headers: { Referer: 'https://finance.naver.com/sise/' }
    });
    const tableRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let found = 0;
    for (const match of tableRows) {
      const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((m) => String(m[1]).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
      if (cells.length < 3 || !/^\d{2}\.\d{2}\.\d{2}$/.test(cells[0])) continue;
      const foreign = signedNumber(cells[2]);
      if (!Number.isFinite(foreign)) continue;
      const [yy, mm, dd] = cells[0].split('.');
      const date = `20${yy}-${mm}-${dd}`;
      if (seen.has(date)) continue;
      seen.add(date);
      rows.push({ date, foreign });
      found += 1;
    }
    if (!found && page > 1) break;
    if (rows.length >= safeLimit) break;
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function lastChange(rows) {
  const valid = rows.filter((row) => Number.isFinite(row.close) && row.close > 0);
  const last = valid[valid.length - 1];
  const prev = valid[valid.length - 2];
  return {
    value: last?.close ?? null,
    changeRate: last?.close && prev?.close ? ((last.close - prev.close) / prev.close) * 100 : null,
    asOf: last?.asOf || last?.date || ''
  };
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function weightedScore(normalizedComponents) {
  const weighted = normalizedComponents.reduce((sum, item) => sum + item.normalized * item.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(50 + weighted * 25)));
  const scale = Math.round((score - 50) / 5) / 2;
  return { score, scale };
}

async function fetchRiskScore() {
  const [vixRows, soxRows, usdkrwRows, us10yRows, us2yRows, kospiRows, futuresRows, breakouts] = await Promise.all([
    fetchMarketRows('^VIX').catch(() => []),
    fetchMarketRows('^SOX').catch(() => []),
    fetchMarketRows('KRW=X').catch(() => []),
    fetchMarketRows('US10Y').catch(() => []),
    fetchMarketRows('US2Y').catch(() => []),
    fetchDaumMarketRows('KOSPI', 10).catch(() => []),
    fetchForeignFuturesRows(20).catch(() => []),
    fetchHighBreakouts().catch(() => null)
  ]);

  const vixLatest = lastChange(vixRows);
  const vixAvg = average(vixRows.slice(-5).map((row) => row.close));
  const volatilityPoint = vixAvg === null ? 0 : vixAvg <= 15 ? 2 : vixAvg <= 20 ? 1 : vixAvg <= 30 ? 0 : -2;

  const us10 = lastChange(us10yRows);
  const us2 = lastChange(us2yRows);
  const fx = lastChange(usdkrwRows);
  const fxAvg = average(usdkrwRows.slice(-5).map((row, index, arr) => index === 0 ? null : ((row.close - arr[index - 1].close) / arr[index - 1].close) * 100));
  const spread = Number.isFinite(us10.value) && Number.isFinite(us2.value) ? us10.value - us2.value : null;
  let ratesFxPoint = 0;
  if (Number.isFinite(spread)) ratesFxPoint += spread >= 0 ? 0.5 : -0.5;
  if (Number.isFinite(fxAvg)) ratesFxPoint += fxAvg <= -0.25 ? 0.5 : fxAvg >= 0.5 ? -1 : 0;
  ratesFxPoint = Math.max(-2, Math.min(2, ratesFxPoint));

  const recentFutures = futuresRows.slice(-5).map((row) => row.foreign).filter(Number.isFinite);
  const futuresSum = recentFutures.reduce((sum, value) => sum + value, 0);
  const flowPoint = !recentFutures.length ? 0 : futuresSum >= 3000 ? 2 : futuresSum <= -3000 ? -2 : futuresSum > 0 ? 1 : futuresSum < 0 ? -1 : 0;

  const highCount = Array.isArray(breakouts?.rows) ? breakouts.rows.length : 0;
  const lowCount = Array.isArray(breakouts?.lowRows) ? breakouts.lowRows.length : 0;
  const breadthPoint = highCount + lowCount === 0 ? 0 : highCount >= lowCount * 2 ? 1 : lowCount >= highCount * 2 ? -1 : 0;

  const sox = lastChange(soxRows);
  const soxAvg = average(soxRows.slice(-5).map((row, index, arr) => index === 0 ? null : ((row.close - arr[index - 1].close) / arr[index - 1].close) * 100));
  const sectorPoint = !Number.isFinite(soxAvg) ? 0 : soxAvg >= 1 ? 1 : soxAvg <= -1 ? -1 : 0;

  const turnoverChanges = kospiRows.slice(-5).map((row, index, arr) => {
    if (index === 0 || !arr[index - 1]?.turnover) return null;
    return ((row.turnover - arr[index - 1].turnover) / arr[index - 1].turnover) * 100;
  });
  const turnoverAvg = average(turnoverChanges);
  const liquidityPoint = !Number.isFinite(turnoverAvg) ? 0 : turnoverAvg >= 0 ? 1 : turnoverAvg <= -10 ? -1 : 0;
  const latestKospi = kospiRows[kospiRows.length - 1] || {};

  const components = [
    { key: 'volatility', name: '변동성 VIX/VKOSPI', weight: 0.30, point: volatilityPoint, normalized: volatilityPoint, value: vixLatest.value, changeRate: vixLatest.changeRate, asOf: vixLatest.asOf, reason: 'VIX 최근 3~5거래일 평균을 15/20/30 기준으로 채점' },
    { key: 'ratesFx', name: '금리·환율', weight: 0.20, point: ratesFxPoint, normalized: ratesFxPoint, value: spread, unit: '스프레드', changeRate: fx.changeRate, asOf: fx.asOf || us10.asOf, reason: 'US10Y-US2Y 스프레드와 원/달러 5일 평균 급등락 반영' },
    { key: 'flow', name: '외국인 선물 수급', weight: 0.20, point: flowPoint, normalized: flowPoint, value: futuresSum, unit: '계약', asOf: futuresRows[futuresRows.length - 1]?.date || '', reason: '최근 5거래일 외국인 선물 순매수 누적, ±3,000계약 기준' },
    { key: 'breadth', name: '시장폭 신고가/신저가', weight: 0.15, point: breadthPoint, normalized: breadthPoint, value: highCount - lowCount, displayValue: `신고가 ${highCount} / 신저가 ${lowCount}`, asOf: breakouts?.latestTradeDate || '', reason: `기존 14개 표기는 신고가-신저가 차이였습니다. 실제 개수는 신고가 ${highCount}개 / 신저가 ${lowCount}개입니다.` },
    { key: 'sectorMomentum', name: '섹터모멘텀 SOX', weight: 0.10, point: sectorPoint, normalized: sectorPoint, value: sox.value, changeRate: sox.changeRate, asOf: sox.asOf, reason: 'SOX 최근 3~5거래일 평균 등락률 ±1% 기준' },
    { key: 'liquidity', name: '유동성 거래대금', weight: 0.05, point: liquidityPoint, normalized: liquidityPoint, value: latestKospi.turnover ? latestKospi.turnover / 1000000 : null, unit: '조원', changeRate: turnoverAvg, asOf: latestKospi.date || '', reason: 'KOSPI 거래대금 전일비 3~5거래일 평균' }
  ];
  const { score } = weightedScore(components);
  const state = score >= 70 ? '우호' : score >= 55 ? '중립' : score >= 40 ? '경계' : '위험';
  return {
    score,
    state,
    components: components.map((item) => ({ ...item, point: Math.round(item.point * 10) / 10, weight: Math.round(item.weight * 100) })),
    method: '기존 대시보드 지표 6개를 3~5거래일 흐름으로 가중합해 계산합니다. 변동성 30%, 금리·환율 20%, 수급 20%, 시장폭 15%, SOX 10%, 유동성 5%.'
  };
}

async function fetchShortSellingSnapshot(item, marketRow) {
  if (!/^\d{6}$/.test(item.code)) return null;
  try {
    const finderBody = new URLSearchParams({
      bld: 'dbms/comm/finder/finder_srtisu',
      locale: 'ko_KR',
      mktsel: 'ALL',
      searchText: item.code
    });
    const finder = await fetchJson('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'POST',
      headers: {
        Referer: 'https://data.krx.co.kr/comm/srt/srtLoader/index.cmd?screenId=MDCSTAT300',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://data.krx.co.kr'
      },
      body: finderBody
    }, 8000);
    const found = (Array.isArray(finder?.block1) ? finder.block1 : []).find((row) => row.short_code === item.code) || finder?.block1?.[0];
    if (!found?.full_code) throw new Error('finder empty');
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 45);
    const dataBody = new URLSearchParams({
      bld: 'dbms/MDC_OUT/STAT/srt/MDCSTAT30001_OUT',
      locale: 'ko_KR',
      isuCd: found.full_code,
      isuCd2: item.code,
      codeNmisuCd_finder_srtisu0: found.codeName || item.name,
      param1isuCd_finder_srtisu0: found.marketCode || 'STK',
      strtDd: formatYmd(start),
      endDd: formatYmd(end)
    });
    const json = await fetchJson('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
      method: 'POST',
      headers: {
        Referer: `https://data.krx.co.kr/comm/srt/srtLoader/index.cmd?screenId=MDCSTAT300&isuCd=${item.code}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://data.krx.co.kr'
      },
      body: dataBody
    }, 9000);
    const rows = Array.isArray(json?.OutBlock_1) ? json.OutBlock_1 : [];
    const latest = rows.find((row) => number(row.STR_CONST_VAL1) !== null || number(row.STR_CONST_VAL2) !== null);
    const balanceQty = number(latest?.STR_CONST_VAL1);
    const balanceAmount = number(latest?.STR_CONST_VAL2);
    const listedStockCnt = marketRow?.listedStockCnt ?? item.listedStockCnt ?? null;
    const ratio = balanceQty !== null && listedStockCnt ? (balanceQty / listedStockCnt) * 100 : (balanceAmount !== null && marketRow?.marketCap ? (balanceAmount / marketRow.marketCap) * 100 : null);
    return {
      code: item.code,
      name: item.name,
      balance: balanceQty,
      balanceAmount,
      ratio,
      overheat: null,
      asOf: latest?.TRD_DD || '',
      status: latest ? 'KRX 공매도 종합정보' : '최근 잔고 미공표',
      url: `https://stock.naver.com/domestic/stock/${item.code}/shortTrade`
    };
  } catch (error) {
    return {
      code: item.code,
      name: item.name,
      balance: null,
      balanceAmount: null,
      ratio: null,
      overheat: null,
      asOf: '',
      status: `공매도 원천 확인 실패: ${error.message || error}`,
      url: `https://stock.naver.com/domestic/stock/${item.code}/shortTrade`
    };
  }
}

function buildReferencePanels(sectors, marketRows) {
  const kospiTop = marketRows.filter((row) => row.marketType === 'KOSPI').slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 12);
  const kosdaqTop = marketRows.filter((row) => row.marketType === 'KOSDAQ').slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 12);
  return {
    kospiIndustry: kospiTop.map((row) => ({ ...row, url: `https://stock.naver.com/domestic/stock/${row.code}/price` })),
    kosdaqIndustry: kosdaqTop.map((row) => ({ ...row, url: `https://stock.naver.com/domestic/stock/${row.code}/price` })),
    themes: sectors.slice().sort((a, b) => (Number(b.changeRate) || -Infinity) - (Number(a.changeRate) || -Infinity)).map((sector, index) => ({
      rank: index + 1,
      name: sector.name,
      changeRate: sector.changeRate,
      stockCount: sector.covered,
      upRatio: sector.upRatio,
      marketCap: sector.marketCap,
      foreignValue: sector.foreignValue,
      institutionValue: sector.institutionValue,
      topStocks: sector.stocks
    }))
  };
}

async function fetchDashboardPanelsFresh(watchlistConfig) {
  const marketRows = await fetchMarketUniverse().catch(() => []);
  const marketByCode = new Map(marketRows.map((row) => [row.code, row]));
  const watchlist = await Promise.all(watchlistConfig.map(async (item) => {
    try {
      return item.market === 'KR'
        ? await fetchKoreanSnapshot(item.code, item.name, marketByCode.get(item.code))
        : await fetchUsSnapshot(item.code, item.name);
    } catch (error) {
      const marketRow = marketByCode.get(item.code);
      return {
        ...item,
        name: marketRow?.name || item.name,
        price: marketRow?.price ?? null,
        changeRate: marketRow?.changeRate ?? null,
        volumeRatio: null,
        marketCap: marketRow?.marketCap ?? null,
        listedStockCnt: marketRow?.listedStockCnt ?? null,
        error: String(error.message || error)
      };
    }
  }));
  const snapshotByCode = new Map(watchlist.filter((item) => item.market === 'KR').map((item) => [item.code, item]));
  const [sectors, disclosures, riskScore] = await Promise.all([
    fetchSectorRows(snapshotByCode, marketByCode),
    fetchDisclosureRows(watchlist),
    fetchRiskScore()
  ]);
  const shortSelling = await Promise.all(watchlist.filter((item) => item.market === 'KR').map((item) => fetchShortSellingSnapshot(item, marketByCode.get(item.code))));
  return {
    asOf: new Date().toISOString(),
    watchlist,
    sectors,
    shortSelling,
    disclosures,
    calendar: buildCalendar(),
    riskScore,
    referencePanels: buildReferencePanels(sectors, marketRows),
    notes: {
      sectors: '20개 섹터를 대표종목 시가총액 순서로 배열했습니다. 색이 진할수록 평균 등락률 폭이 큽니다.',
      shortSelling: 'KRX 개별종목 공매도 종합정보에서 잔고가 공표된 최근일의 잔고수량과 상장주식수 대비 비중을 표시합니다.',
      disclosures: '네이버페이 증권이 제공하는 KRX·DART 계열 공개 공시와 관심종목 최신 뉴스입니다.'
    }
  };
}

async function fetchDashboardPanels(watchlistInput) {
  const watchlist = normalizeWatchlist(watchlistInput);
  const key = watchlist.map((item) => `${item.name}:${item.code}`).join(',');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = fetchDashboardPanelsFresh(watchlist).then((payload) => {
    if (cache.size >= 20) cache.clear();
    cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return payload;
  }).finally(() => { inFlight.delete(key); });
  inFlight.set(key, request);
  return request;
}

module.exports = { fetchDashboardPanels };
