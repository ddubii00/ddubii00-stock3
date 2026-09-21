import { createServer } from 'node:http';
import { parseTrades, subscription } from './kis-protocol.mjs';
import { multiBatches, multiCacheKey } from './kis-multi.mjs';
import { createMarketCalendar } from './kis-market-calendar.mjs';
import { dailyRows, parseRegularDailyClose } from './kis-daily-close.mjs';
import { parseRegularHistoricalClose } from './kis-regular-close.mjs';
import { parseNxtFinalClose } from './kis-nxt-close.mjs';
import { domesticQuotePlan } from './kis-domestic-routing.mjs';

const appKey = process.env.KIS_APP_KEY;
const appSecret = process.env.KIS_APP_SECRET;
const port = Number(process.env.KIS_RELAY_PORT || 8091);
// Bind to loopback normally; Docker opts into its unexposed private network.
const host = process.env.KIS_RELAY_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
const limit = Math.max(1, Math.min(40, Number(process.env.KIS_MAX_SUBSCRIPTIONS) || 40));
const clients = new Set();
const sent = new Map();
const accepted = new Set();
// A KIS acknowledgement can fail transiently. Keep it out of the rapid 500 ms
// reconcile loop, then try it again instead of leaving the subscription stuck.
const rejected = new Map();
const SUBSCRIPTION_RETRY_MS = 30_000;
let socket, approval, approvalExpires = 0, connecting = false, retryAt = 0;
let state = appKey && appSecret ? 'idle' : 'unconfigured';
let accessToken, accessTokenExpires = 0, tokenPending;
const regularCloseCache = new Map();
const afterSessionCache = new Map();
const multiQuoteCache = new Map();
const multiQuotePending = new Map();
// This is intentionally separate from the short TTL cache. A valid NX final
// must survive a blank post-close response without ever borrowing a J price.
const afterFinalQuoteCache = new Map();
const regularDailyCloseCache = new Map();
const regularDailyClosePending = new Map();
const regularHistoricalCloseCache = new Map();
const regularHistoricalClosePending = new Map();
const nxtFinalCloseCache = new Map();
const nxtFinalClosePending = new Map();
const latestTradeDateCache = new Map();
const REGULAR_CLOSE_RETRY_MS = 30_000;
const NXT_CLOSE_RETRY_MS = 30_000;
const KIS_ORIGIN = process.env.KIS_ORIGIN || 'https://openapi.koreainvestment.com:9443';
const QUOTE_TTL = 25_000;
const watchRefreshMs = Math.max(500, Number(process.env.KIS_WATCHLIST_REFRESH_MS) || 2_000);
const visibleRefreshMs = Math.max(1_000, Number(process.env.KIS_VISIBLE_REFRESH_MS) || 3_000);
const backgroundRefreshMs = Math.max(10_000, Number(process.env.KIS_BACKGROUND_REFRESH_MS) || 20_000);
const restMinInterval = Math.max(100, Number(process.env.KIS_REST_MIN_INTERVAL_MS) || 350);
const restMaxConcurrency = Math.max(1, Math.min(8, Number(process.env.KIS_REST_MAX_CONCURRENCY) || 2));
const diagnostics = { restRequests: 0, restSuccess: 0, restFailures: 0, restRateLimited: 0, restRetries: 0, multiRestRequests: 0, multiRestSuccess: 0, multiRestFailures: 0, lastSuccessAt: '', lastError: new Map(), subscriptionErrors: new Map() };
const restQueue = []; let restActive = 0, restLastStarted = 0, restTimer;

function domestic(market) { return market === 'KOSPI' || market === 'KOSDAQ'; }
function quoteKey(market, code) { return `${market}:${code}`; }
function number(value) { return Number(String(value ?? '').replaceAll(',', '')); }
function signed(value, sign) {
  const parsed = number(value);
  if (!Number.isFinite(parsed)) return parsed;
  return ['4', '5'].includes(String(sign)) ? -Math.abs(parsed) : String(sign) === '3' ? 0 : parsed;
}
function multiTtl(scope) { return scope === 'watch' ? watchRefreshMs : scope === 'background' ? backgroundRefreshMs : visibleRefreshMs; }
function multiRows(body) {
  // The official multprice TR returns `output`; accept only its documented
  // row container forms so a partial response stays partial and falls back.
  if (Array.isArray(body?.output)) return body.output;
  if (Array.isArray(body?.output?.items)) return body.output.items;
  if (body?.output && typeof body.output === 'object' && typeof body.output.inter_shrn_iscd === 'string') return [body.output];
  return [];
}
function multiQuote(row, market, session) {
  const price = number(row?.inter2_prpr);
  const changePrice = signed(row?.inter2_prdy_vrss, row?.prdy_vrss_sign);
  const change = signed(row?.prdy_ctrt, row?.prdy_vrss_sign);
  const directPreviousClose = number(row?.inter2_prdy_clpr);
  const previousClose = directPreviousClose > 0 ? directPreviousClose : price - changePrice;
  if (![price, changePrice, change, previousClose].every(Number.isFinite) || price <= 0 || previousClose <= 0) return undefined;
  const { minute } = seoulClock();
  return { chartCode: String(row.inter_shrn_iscd), ...(typeof row.inter_kor_isnm === 'string' && row.inter_kor_isnm ? { name: row.inter_kor_isnm } : {}), price, change, changePrice, previousClose,
    ...(Number.isFinite(number(row?.acml_vol)) ? { volume: String(number(row.acml_vol)) } : {}),
    // This TR does not provide a per-trade timestamp. Keep the retrieval time
    // distinct rather than inventing an `asOf` trade time.
    asOf: '', fetchedAt: new Date().toISOString(), marketStatus: session === 'after' ? 'AFTER' : minute > 930 ? 'CLOSE' : 'OPEN', priceSource: 'kis-multi-rest', priceSession: session };
}
function seoulParts() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {}); }
function seoulClock() { const part = seoulParts(); return { date: `${part.year}${part.month}${part.day}`, minute: Number(part.hour) * 60 + Number(part.minute) }; }
function reportRestError({ market, code, session, status, body, timeout }) {
  diagnostics.restFailures++;
  if (status === 429 || body?.msg_cd === 'EGW00201') diagnostics.restRateLimited++;
  const message = JSON.stringify({ market, code, session, status, rt_cd: body?.rt_cd, msg_cd: body?.msg_cd, msg1: body?.msg1, timeout: Boolean(timeout) });
  const key = `${market}:${code}:${session}:${status ?? 'network'}:${body?.msg_cd ?? ''}`;
  if (diagnostics.lastError.get(key) !== message) { diagnostics.lastError.set(key, message); console.warn(`KIS REST failure ${message}`); }
}
function reportRestShape({ market, code, session, body }) {
  if (process.env.KIS_RELAY_DEBUG_FIELDS !== '1') return;
  const output = body?.output;
  // Schema-only diagnostics: credentials and opaque response bodies never log.
  console.info('KIS REST schema', JSON.stringify({ market, code, session, rt_cd: body?.rt_cd, msg_cd: body?.msg_cd, msg1: body?.msg1,
    outputFields: output && typeof output === 'object' ? Object.keys(output).sort() : [],
    values: { stck_prpr: output?.stck_prpr, stck_prdy_clpr: output?.stck_prdy_clpr, prdy_vrss: output?.prdy_vrss, prdy_ctrt: output?.prdy_ctrt, acml_vol: output?.acml_vol, stck_bsop_date: output?.stck_bsop_date, stck_cntg_hour: output?.stck_cntg_hour } }));
}
function reportSubscriptionError(id, body) {
  // Keep only public symbol/subscription metadata: approvals and credentials
  // are never stored or logged.
  const value = JSON.stringify({ id, rt_cd: body?.rt_cd, msg_cd: body?.msg_cd, msg1: body?.msg1 });
  if (diagnostics.subscriptionErrors.get(id) !== value) {
    diagnostics.subscriptionErrors.set(id, value);
    console.warn(`KIS WebSocket subscription failure ${value}`);
  }
}
function drainRestQueue() {
  clearTimeout(restTimer);
  if (!restQueue.length || restActive >= restMaxConcurrency) return;
  const delay = Math.max(0, restMinInterval - (Date.now() - restLastStarted));
  if (delay) { restTimer = setTimeout(drainRestQueue, delay); return; }
  const job = restQueue.shift(); restActive++; restLastStarted = Date.now(); diagnostics.restRequests++;
  void job().finally(() => { restActive--; drainRestQueue(); });
  if (restActive < restMaxConcurrency) drainRestQueue();
}
function queueRest(job) { return new Promise((resolve, reject) => { restQueue.push(async () => { try { resolve(await job()); } catch (error) { reject(error); } }); drainRestQueue(); }); }
async function token() {
  if (accessToken && accessTokenExpires > Date.now() + 60_000) return accessToken;
  if (tokenPending) return tokenPending;
  tokenPending = (async () => {
    const response = await fetch(`${KIS_ORIGIN}/oauth2/tokenP`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.access_token !== 'string') throw new Error('KIS token unavailable');
    accessToken = body.access_token;
    // KIS tokens are long lived; rotate early without parsing or logging it.
    accessTokenExpires = Date.now() + 23 * 60 * 60 * 1000;
    return accessToken;
  })();
  try { return await tokenPending; } finally { tokenPending = undefined; }
}
async function kisGet(path, trId, params, market, code, session) {
  return queueRest(async () => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = new URL(path, KIS_ORIGIN);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      let response, body;
      try {
        response = await fetch(url, { headers: { authorization: `Bearer ${await token()}`, appkey: appKey, appsecret: appSecret, tr_id: trId }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
        body = await response.json();
      } catch (error) {
        lastError = error; reportRestError({ market, code, session, timeout: error?.name === 'TimeoutError' });
      }
      if (response?.ok && body?.rt_cd === '0') { diagnostics.restSuccess++; reportRestShape({ market, code, session, body }); return body; }
      const retry = !response || response.status === 429 || response.status >= 500 || ['EGW00123', 'EGW00201'].includes(body?.msg_cd);
      reportRestError({ market, code, session, status: response?.status, body, timeout: !response });
      if (!retry || attempt === 2) throw new Error(`KIS REST ${body?.msg_cd ?? response?.status ?? 'network'}`);
      diagnostics.restRetries++;
      await new Promise((resolve) => setTimeout(resolve, (250 * (2 ** attempt)) + Math.floor(Math.random() * 100)));
    }
    throw lastError ?? new Error('KIS REST unavailable');
  });
}
const marketCalendar = createMarketCalendar({
  clock: seoulClock,
  fetchHoliday: (date) => {
    if (!appKey || !appSecret) throw new Error('KIS calendar unconfigured');
    return kisGet('/uapi/domestic-stock/v1/quotations/chk-holiday', 'CTCA0903R', {
      BASS_DT: date, CTX_AREA_FK: '', CTX_AREA_NK: '',
    }, 'KOSPI', `calendar:${date}`, 'calendar');
  },
});
async function readRegularDailyClose(market, code, open, clock) {
  const key = quoteKey(market, code);
  // After 15:30 on an open day today's official KRX daily close is required.
  // Before the opening bell and on closed days the latest trading row is valid.
  const requireToday = open && clock.minute >= 930;
  const cached = regularDailyCloseCache.get(key);
  if (cached?.quote && (!requireToday || cached.tradeDate === clock.date)) return cached.quote;
  if (cached?.retryAt && cached.retryAt > Date.now()) return undefined;
  if (regularDailyClosePending.has(key)) return regularDailyClosePending.get(key);
  const task = (async () => {
    try {
      const body = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0',
      }, market, code, 'regular-close');
      const parsed = parseRegularDailyClose(body, code);
      if (!parsed || (requireToday && parsed.tradeDate !== clock.date)) {
        // Never label yesterday's row as today's KRX close. Preserve any older
        // cache but return undefined so the verified Naver regular fallback wins.
        regularDailyCloseCache.set(key, { ...(cached?.quote ? cached : {}), retryAt: Date.now() + REGULAR_CLOSE_RETRY_MS });
        return undefined;
      }
      regularDailyCloseCache.set(key, { tradeDate: parsed.tradeDate, quote: parsed.quote });
      return parsed.quote;
    } catch {
      regularDailyCloseCache.set(key, { ...(cached?.quote ? cached : {}), retryAt: Date.now() + REGULAR_CLOSE_RETRY_MS });
      return undefined;
    }
  })();
  regularDailyClosePending.set(key, task);
  try { return await task; } finally { regularDailyClosePending.delete(key); }
}
async function domesticRegularCloseQuotes(market, codes, scope, open, clock) {
  // Do not create 200 separate history calls while merely warming background.
  if (scope === 'background') return { quotes: {}, cache: true, refreshMs: backgroundRefreshMs };
  const quotes = {};
  const values = await Promise.allSettled(codes.map(async (code) => ({ code, quote: await readRegularDailyClose(market, code, open, clock) })));
  for (const value of values) if (value.status === 'fulfilled' && value.value.quote) quotes[value.value.code] = value.value.quote;
  return { quotes, cache: false, refreshMs: multiTtl(scope) };
}
async function readRegularHistoricalClose(market, code, tradeDate) {
  const key = `${quoteKey(market, code)}:${tradeDate}`;
  const cached = regularHistoricalCloseCache.get(key);
  if (cached?.quote) return cached.quote;
  if (cached?.retryAt && cached.retryAt > Date.now()) return undefined;
  if (regularHistoricalClosePending.has(key)) return regularHistoricalClosePending.get(key);

  const task = (async () => {
    try {
      const body = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice', 'FHKST03010230', {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: code,
        FID_INPUT_HOUR_1: '153000',
        FID_INPUT_DATE_1: tradeDate,
        FID_PW_DATA_INCU_YN: 'N',
        FID_FAKE_TICK_INCU_YN: '',
      }, market, code, 'regular-history');

      const parsed = parseRegularHistoricalClose(body, code, tradeDate);
      if (!parsed?.quote) {
        regularHistoricalCloseCache.set(key, { retryAt: Date.now() + REGULAR_CLOSE_RETRY_MS });
        return undefined;
      }

      regularHistoricalCloseCache.set(key, { tradeDate: parsed.tradeDate, quote: parsed.quote });
      return parsed.quote;
    } catch {
      regularHistoricalCloseCache.set(key, { retryAt: Date.now() + REGULAR_CLOSE_RETRY_MS });
      return undefined;
    }
  })();

  regularHistoricalClosePending.set(key, task);
  try { return await task; } finally { regularHistoricalClosePending.delete(key); }
}

async function domesticRegularHistoricalQuotes(market, codes, scope, open, clock) {
  if (scope === 'background' || !codes.length) {
    return { quotes: {}, cache: true, refreshMs: scope === 'background' ? backgroundRefreshMs : multiTtl(scope) };
  }

  // daily-price is used only to discover the latest KRX business date. Its
  // stck_clpr is intentionally ignored because it can reflect the NXT final.
  const tradeDate = await resolveLatestTradingDate(market, codes[0], open, clock);
  if (!tradeDate) return { quotes: {}, cache: false, refreshMs: multiTtl(scope) };

  const quotes = {};
  const values = await Promise.allSettled(codes.map(async (code) => ({
    code,
    quote: await readRegularHistoricalClose(market, code, tradeDate),
  })));
  for (const value of values) {
    if (value.status === 'fulfilled' && value.value.quote) quotes[value.value.code] = value.value.quote;
  }
  return { quotes, cache: false, refreshMs: multiTtl(scope) };
}
async function resolveLatestTradingDate(market, sampleCode, open, clock) {
  const cachedDate = latestTradeDateCache.get(market);
  if (cachedDate?.calendarDate === clock.date && cachedDate.tradeDate) return cachedDate.tradeDate;

  // Once an open KRX business day has reached the regular close, today's
  // intraday history is the authoritative session. The daily-price endpoint
  // can lag behind and still report the previous business date for a while,
  // which made quote cards show the prior close while the minute chart already
  // showed today's session. Pin the closed-session lookup to today instead.
  if (open && clock.minute >= 930) {
    latestTradeDateCache.set(market, { calendarDate: clock.date, tradeDate: clock.date });
    return clock.date;
  }

  try {
    const body = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: sampleCode,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    }, market, sampleCode, 'trade-date');

    const tradeDate = dailyRows(body)
      .map((row) => String(row?.stck_bsop_date ?? ''))
      .filter((date) => /^\d{8}$/.test(date))
      .sort((left, right) => right.localeCompare(left))[0];

    if (!tradeDate) return undefined;
    // After today's KRX close, never silently fall back to an older business
    // date while KIS is still publishing today's history.
    if (open && clock.minute >= 930 && tradeDate !== clock.date) return undefined;

    latestTradeDateCache.set(market, { calendarDate: clock.date, tradeDate });
    return tradeDate;
  } catch {
    return undefined;
  }
}
async function readNxtFinalClose(market, code, tradeDate) {
  const key = `${quoteKey(market, code)}:${tradeDate}`;
  const cached = nxtFinalCloseCache.get(key);
  if (cached?.quote) return cached.quote;
  if (cached?.retryAt && cached.retryAt > Date.now()) return undefined;
  if (nxtFinalClosePending.has(key)) return nxtFinalClosePending.get(key);
  const task = (async () => {
    try {
      const body = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice', 'FHKST03010230', {
        FID_COND_MRKT_DIV_CODE: 'NX', FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: '200000', FID_INPUT_DATE_1: tradeDate,
        FID_PW_DATA_INCU_YN: 'N', FID_FAKE_TICK_INCU_YN: '',
      }, market, code, 'nxt-close');
      const regular = regularDailyCloseCache.get(quoteKey(market, code))?.quote;
      const parsed = parseNxtFinalClose(body, code, tradeDate, regular?.previousClose);
      if (!parsed?.quote) { nxtFinalCloseCache.set(key, { retryAt: Date.now() + NXT_CLOSE_RETRY_MS }); return undefined; }
      nxtFinalCloseCache.set(key, { tradeDate: parsed.tradeDate, quote: parsed.quote });
      return parsed.quote;
    } catch {
      nxtFinalCloseCache.set(key, { retryAt: Date.now() + NXT_CLOSE_RETRY_MS });
      return undefined;
    }
  })();
  nxtFinalClosePending.set(key, task);
  try { return await task; } finally { nxtFinalClosePending.delete(key); }
}
async function domesticNxtFinalQuotes(market, codes, scope, open, clock) {
  if (scope === 'background' || !codes.length) return { quotes: {}, cache: true, refreshMs: scope === 'background' ? backgroundRefreshMs : multiTtl(scope) };
  const tradeDate = await resolveLatestTradingDate(market, codes[0], open, clock);
  if (!tradeDate) return { quotes: {}, cache: false, refreshMs: multiTtl(scope) };
  const quotes = {};
  const work = [];
  for (const code of codes) {
    const key = `${quoteKey(market, code)}:${tradeDate}`;
    const cached = nxtFinalCloseCache.get(key);
    if (cached?.quote) quotes[code] = cached.quote;
    else work.push(readNxtFinalClose(market, code, tradeDate));
  }
  // Naver's existing overMarketPriceInfo remains the immediate fallback while
  // this per-symbol historical cache warms through the shared KIS queue.
  if (work.length) void Promise.allSettled(work);
  return { quotes, cache: false, refreshMs: multiTtl(scope) };
}
async function domesticMultiQuotes(market, codes, requestedAfter, scope) {
  const session = await marketCalendar.sessionFor(requestedAfter);
  const clock = seoulClock();
  const open = await marketCalendar.isOpenTradingDay(clock.date);
  const plan = domesticQuotePlan({ session, open, minute: clock.minute });
  if (plan.source === 'daily-close') return domesticRegularHistoricalQuotes(market, codes, scope, open, clock);
  if (plan.source === 'nxt-close') return domesticNxtFinalQuotes(market, codes, scope, open, clock);
  const batches = multiBatches(codes, plan.marketCode);
  const canonical = batches.flatMap((batch) => batch.codes);
  const cacheKey = multiCacheKey(market, session, codes);
  const ttl = multiTtl(scope);
  const cached = multiQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttl) return { quotes: cached.quotes, cache: true, refreshMs: ttl };
  if (multiQuotePending.has(cacheKey)) return multiQuotePending.get(cacheKey);
  const task = (async () => {
    const quotes = {};
    try {
      for (const batch of batches) {
        // KIS official sample: FID_COND_MRKT_DIV_CODE_1..30 paired with
        // FID_INPUT_ISCD_1..30. KRX2 switches only during the NXT session.
        diagnostics.multiRestRequests++;
        const body = await kisGet('/uapi/domestic-stock/v1/quotations/intstock-multprice', 'FHKST11300006', batch.params, market, batch.codes.join(','), session);
        const rows = multiRows(body);
        if (!rows.length) throw new Error('KIS multi quote response unavailable');
        for (const row of rows) {
          const value = multiQuote(row, market, session);
          if (value && canonical.includes(value.chartCode)) quotes[value.chartCode] = value;
        }
      }
      diagnostics.multiRestSuccess++;
      diagnostics.lastSuccessAt = new Date().toISOString();
      // A partial after-market reply may omit a symbol. Preserve a previously
      // validated NX final only for that missing NX symbol; never substitute J.
      if (session === 'after') {
        const previous = afterFinalQuoteCache.get(cacheKey)?.quotes ?? {};
        for (const code of canonical) if (!quotes[code] && previous[code]) quotes[code] = { ...previous[code], priceSource: 'kis-cache', priceSession: 'after' };
        if (Object.keys(quotes).length) afterFinalQuoteCache.set(cacheKey, { quotes: { ...quotes }, fetchedAt: Date.now() });
      }
      multiQuoteCache.set(cacheKey, { quotes, fetchedAt: Date.now() });
      return { quotes, cache: false, refreshMs: ttl };
    } catch (error) {
      diagnostics.multiRestFailures++;
      if (session === 'after') {
        const previous = afterFinalQuoteCache.get(cacheKey);
        if (previous?.quotes && Object.keys(previous.quotes).length) return { quotes: previous.quotes, cache: true, refreshMs: ttl };
      }
      throw error;
    }
  })();
  multiQuotePending.set(cacheKey, task);
  try { return await task; } finally { multiQuotePending.delete(cacheKey); }
}

function event(client, name, data) {
  if (client.response.destroyed) return;
  // Drop slow connections instead of accumulating an unbounded quote backlog.
  if (client.response.writableLength > 256_000) { client.response.destroy(); return; }
  client.response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
function status() {
  for (const client of clients) {
    const subscribed = client.subscriptions.filter((item) => accepted.has(item.id)).length;
    const value = { state, subscribed, requested: client.requested, limit };
    const signature = JSON.stringify(value);
    if (signature !== client.lastStatus) { event(client, 'status', value); client.lastStatus = signature; }
  }
}
function desired() {
  const result = new Map();
  for (const client of clients) for (const item of client.subscriptions) {
    if (result.size < limit || result.has(item.id)) result.set(item.id, item);
  }
  return result;
}
function canRetrySubscription(id) {
  const retryAt = rejected.get(id);
  if (!retryAt) return true;
  if (retryAt <= Date.now()) { rejected.delete(id); return true; }
  return false;
}
async function connect() {
  if (!appKey || !appSecret || connecting || !clients.size || Date.now() < retryAt || (socket && socket.readyState < 2)) return;
  connecting = true;
  state = 'connecting'; status();
  try {
    if (!approval || approvalExpires < Date.now()) {
      const response = await fetch('https://openapi.koreainvestment.com:9443/oauth2/Approval', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.approval_key !== 'string') throw new Error('Approval failed');
      approval = body.approval_key;
      approvalExpires = Date.now() + 23 * 60 * 60 * 1000;
    }
    socket = new WebSocket('ws://ops.koreainvestment.com:21000');
    const current = socket;
    const handshakeTimeout = setTimeout(() => { if (current.readyState === WebSocket.CONNECTING) current.close(); }, 15_000);
    socket.addEventListener('open', () => { clearTimeout(handshakeTimeout); sent.clear(); accepted.clear(); rejected.clear(); diagnostics.subscriptionErrors.clear(); state = 'connected'; status(); });
    socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      if (data.startsWith('{')) {
        try {
          const value = JSON.parse(data);
          if (value.header?.tr_id === 'PINGPONG') { current.send(data); return; }
          const id = `${value.header?.tr_id}:${value.header?.tr_key}`;
          if (value.body?.rt_cd === '0' && sent.has(id)) { accepted.add(id); rejected.delete(id); diagnostics.subscriptionErrors.delete(id); }
          else if (value.body?.rt_cd === '1') {
            accepted.delete(id); sent.delete(id); rejected.set(id, Date.now() + SUBSCRIPTION_RETRY_MS); reportSubscriptionError(id, value.body);
            if (String(value.body?.msg1).toLowerCase().includes('approval')) approvalExpires = 0;
          }
          status();
        } catch { /* Ignore malformed acknowledgements; never log credentials. */ }
        return;
      }
      for (const tick of parseTrades(data)) {
        const item = sent.get(tick.subscriptionId);
        if (!item) continue;
        accepted.add(item.id); rejected.delete(item.id); diagnostics.subscriptionErrors.delete(item.id);
        for (const client of clients) if (client.ids.has(item.id)) {
          const cache = tick.session === 'after' ? afterSessionCache : regularCloseCache;
          const key = quoteKey(client.market, item.code);
          // The last H0STCNT0 print is the immutable regular close for that
          // business date. H0UNCNT0 has a wholly separate after-session map.
          if (tick.session === 'after' || tick.minute <= 930 || !cache.has(key)) cache.set(key, { expires: tick.session === 'after' ? Date.now() + QUOTE_TTL : undefined, value: { ...tick, chartCode: item.code, marketStatus: tick.session === 'after' ? 'AFTER' : tick.minute >= 930 ? 'CLOSE' : 'OPEN', priceSource: 'kis-live', priceSession: tick.session } });
          event(client, 'quote', { ...tick, code: item.code, market: client.market });
        }
      }
    });
    socket.addEventListener('error', () => { state = 'reconnecting'; status(); current.close(); });
    socket.addEventListener('close', () => {
      clearTimeout(handshakeTimeout); sent.clear(); accepted.clear(); rejected.clear();
      if (!clients.size) { state = 'idle'; retryAt = 0; }
      else { state = 'reconnecting'; retryAt = Date.now() + 30_000; }
      status();
    });
  } catch { state = 'error'; retryAt = Date.now() + 60_000; status(); }
  finally { connecting = false; }
}

// One shared upstream and at most two subscription changes per second.
const reconcile = setInterval(() => {
  void connect();
  if (socket?.readyState !== WebSocket.OPEN) return;
  const wanted = desired();
  const removed = [...sent.values()].find((item) => !wanted.has(item.id));
  const added = [...wanted.values()].find((item) => !sent.has(item.id) && canRetrySubscription(item.id));
  const item = removed || added;
  if (!item) { status(); return; }
  try {
    socket.send(JSON.stringify({ header: { approval_key: approval, custtype: 'P', tr_type: removed ? '2' : '1', 'content-type': 'utf-8' }, body: { input: { tr_id: item.trId, tr_key: item.key } } }));
    if (removed) { sent.delete(item.id); accepted.delete(item.id); rejected.delete(item.id); }
    else sent.set(item.id, item);
  } catch { socket.close(); }
  status();
}, 500);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    const calendar = marketCalendar.diagnostics();
    response.end(JSON.stringify({ state, configured: Boolean(appKey && appSecret), restQueueDepth: restQueue.length, restRequests: diagnostics.restRequests, restSuccess: diagnostics.restSuccess, restFailures: diagnostics.restFailures, restRateLimited: diagnostics.restRateLimited, restRetries: diagnostics.restRetries, multiRestRequests: diagnostics.multiRestRequests, multiRestSuccess: diagnostics.multiRestSuccess, multiRestFailures: diagnostics.multiRestFailures, lastSuccessAt: diagnostics.lastSuccessAt || undefined, cacheSize: multiQuoteCache.size, regularCacheSize: regularCloseCache.size, afterCacheSize: afterSessionCache.size, marketCalendarDate: calendar.date ?? seoulClock().date, marketCalendarOpen: calendar.open ?? null, recentErrors: [...diagnostics.lastError.values()].slice(-12).map((entry) => JSON.parse(entry)) })); return;
  }
  const market = url.searchParams.get('market');
  const codes = [...new Set((url.searchParams.get('codes') || '').split(',').filter(Boolean))];
  const after = url.searchParams.get('after') === '1';
  const scope = ['watch', 'visible', 'background'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'visible';
  if (request.method === 'GET' && url.pathname === '/quotes' && ['KOSPI', 'KOSDAQ', 'NASDAQ', 'NYSE', 'AMEX'].includes(market) && codes.length && codes.length <= 200 && codes.every((code) => /^[A-Za-z0-9.^-]{1,24}$/.test(code))) {
    const session = domestic(market) ? await marketCalendar.sessionFor(after) : 'regular';
    const quotes = {}, errors = {};
    let refreshMs = multiTtl(scope);
    if (domestic(market)) {
      try {
        const result = await domesticMultiQuotes(market, codes, after, scope);
        Object.assign(quotes, result.quotes); refreshMs = result.refreshMs;
        for (const code of codes) if (!quotes[code]) errors[code] = 'KIS multi quote unavailable';
      } catch (error) {
        for (const code of codes) errors[code] = error instanceof Error ? error.message : 'KIS multi quote unavailable';
      }
    } else {
      // Overseas remains WebSocket-cache backed; no undocumented KIS REST is
      // invented for markets outside this domestic multi-quote policy.
      for (const code of codes) {
        const hit = regularCloseCache.get(quoteKey(market, code));
        if (hit) quotes[code] = { ...hit.value, priceSource: 'kis-cache' };
      }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ quotes, errors, session, source: domestic(market) ? 'kis-multi-rest' : 'kis-relay', refreshMs })); return;
  }
  if (request.method !== 'GET' || url.pathname !== '/stream' || !['NASDAQ', 'NYSE', 'AMEX'].includes(market) || !codes.length || codes.length > 200 || codes.some((code) => !/^[A-Za-z0-9.^-]{1,24}$/.test(code))) {
    response.writeHead(400); response.end('Invalid market or symbols'); return;
  }
  if (clients.size >= 20) { response.writeHead(503); response.end('Connection limit'); return; }
  const subscriptions = codes.map((code) => subscription(market, code, after && domestic(market) ? 'after' : 'regular')).filter(Boolean);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write('retry: 5000\n\n');
  const client = { response, market, subscriptions, ids: new Set(subscriptions.map((item) => item.id)), requested: codes.length, lastStatus: '' };
  clients.add(client); status(); void connect();
  const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15_000);
  response.on('close', () => { clearInterval(keepalive); clients.delete(client); if (!clients.size && state === 'connected') { state = 'idle'; socket?.close(); } });
});
server.listen(port, host, () => console.info(`Stock11 quote relay: http://${host}:${server.address().port} (${state})`));
function shutdown() { clearInterval(reconcile); for (const client of clients) client.response.end(); socket?.close(); server.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
