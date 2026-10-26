'use strict';

/**
 * stock3 KIS flow gateway
 *
 * Purpose
 * - Keep the existing stock3 server.js untouched.
 * - Run it on an internal localhost port.
 * - Listen on the original PORT and intercept only the KIS flow endpoints:
 *     /api/extra-chart?kind=kospi-investor-minute
 *     /api/extra-chart?kind=kosdaq-investor-minute
 *     /api/extra-chart?kind=foreign-futures-minute
 *     /api/stats
 *     /api/kis-flow-health
 * - Everything else is transparently proxied to the original server.js.
 *
 * KIS sources
 * - 시장별 투자자매매동향(시세) FHPTJ04030000
 *   KOSPI: KSP / 0001
 *   KOSDAQ: KSQ / 1001
 *   KOSPI200 futures: K2I / F001
 * - 시장별 투자자매매동향(일별) FHPTJ04040000
 *   Used to provide a final 15:30 marker when no intraday history exists.
 * - 프로그램매매 종합현황(시간) FHPPG04600101
 * - 프로그램매매 종합현황(일별) FHPPG04600001
 * - 국내휴장일조회 CTCA0903R
 *
 * Polling
 * - Every 30 seconds during the regular session.
 * - Stored as 1-minute points (the same minute is overwritten by the latest 30s poll).
 * - Data is persisted under .runtime/kis-flow-gateway.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sumWindows, mergeWindowValues, mergeFlowStats, numericOrNull } = require('./flow-stats');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8000);
const CORE_PORT = Number(process.env.STOCK3_CORE_PORT || (PORT + 10000));
const CORE_HOST = '127.0.0.1';
const STORE_PATH = process.env.KIS_FLOW_STORE_PATH || path.join(ROOT, '.runtime', 'kis-flow-gateway.json');
const LEGACY_STORE_PATH = process.env.INVESTOR_INTRADAY_STORE_PATH || path.join(ROOT, '.runtime', 'investor-intraday.json');
const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const POLL_MS = Math.max(30_000, Number(process.env.KIS_FLOW_POLL_MS || 30_000));
const BACKFILL_BASE_URL = process.env.KIS_FLOW_BACKFILL_URL || 'https://158.179.192.139/stock3-7';
const BACKFILL_KINDS = {
  KOSPI: 'kospi-investor-minute',
  KOSDAQ: 'kosdaq-investor-minute',
  FUTURES: 'foreign-futures-minute',
};

const state = {
  token: '',
  tokenExpiresAt: 0,
  latestOpenDate: '',
  pollRunning: false,
  lastPollAt: '',
  lastSuccessAt: '',
  lastErrorAt: '',
  lastError: '',
  lastResults: {},
  coreReady: false,
  backfillDate: '',
  backfillAt: 0,
  backfillPromise: null,
  closingPromise: null,
  lastClosingPollAt: {},
  dailyFallbackAt: {},
  investorRefresh: {},
};
const investorRequests = new Map();
const INVESTOR_REFRESH_MS = 20_000;

const store = {
  version: 2,
  days: {},
  daily: { FUTURES: {} },
  loaded: false,
};

function nowIso() {
  return new Date().toISOString();
}

function getKisCredentials() {
  const env = process.env;
  return {
    appKey: env.KIS_APP_KEY || env.KIS_APPKEY || env.KIS_KEY || env.APP_KEY || env.APPKEY || '',
    appSecret: env.KIS_APP_SECRET || env.KIS_APPSECRET || env.KIS_SECRET || env.APP_SECRET || env.APPSECRET || '',
  };
}

function hasKisCredentials() {
  const { appKey, appSecret } = getKisCredentials();
  return Boolean(appKey && appSecret);
}

function loadKisCredentials() {
  // Credentials are provided by the server environment only. Never read another app's .env file.
  if (!hasKisCredentials()) console.warn('[KIS FLOW] KIS 환경변수가 설정되지 않았습니다.');
}

function getKoreaClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    ymd: `${parts.year}${parts.month}${parts.day}`,
    weekday: parts.weekday,
    hour,
    minute,
    second: Number(parts.second),
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function shiftKoreaDate(dateText, days) {
  const d = new Date(`${dateText}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function ymdToDashed(value) {
  const text = String(value || '').replace(/\D/g, '');
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : '';
}

function toNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return NaN;
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

// KIS *_tr_pbmn values are treated as million KRW in the existing stock3 display convention.
function pbmnToTrillion(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? n / 1_000_000 : NaN;
}

function pbmnToEok(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? n / 100 : NaN;
}

function ensureStoreLoaded() {
  if (store.loaded) return;
  store.loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.days && typeof parsed.days === 'object') store.days = parsed.days;
      if (parsed.daily && typeof parsed.daily === 'object') {
        store.daily = { FUTURES: {}, ...parsed.daily };
        if (!store.daily.FUTURES) store.daily.FUTURES = {};
      }
    }
  } catch (_) {}

  // Import any KIS minute history that the previous stock3 implementation already captured.
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8'));
    if (legacy?.days && typeof legacy.days === 'object') {
      for (const [date, day] of Object.entries(legacy.days)) {
        if (!store.days[date]) store.days[date] = {};
        for (const kind of ['KOSPI', 'KOSDAQ', 'FUTURES']) {
          const incoming = Array.isArray(day?.[kind]) ? day[kind] : [];
          if (!incoming.length) continue;
          const current = Array.isArray(store.days[date][kind]) ? store.days[date][kind] : [];
          const map = new Map([...current, ...incoming].map((row) => [String(row.date || ''), row]));
          store.days[date][kind] = [...map.values()].filter((row) => row.date).sort((a, b) => a.date.localeCompare(b.date));
          if (kind === 'FUTURES') {
            const last = store.days[date][kind].at(-1);
            if (Number.isFinite(Number(last?.foreign))) store.daily.FUTURES[date] = Number(last.foreign);
          }
        }
      }
    }
  } catch (_) {}
}

function persistStore() {
  ensureStoreLoaded();
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const dates = Object.keys(store.days).sort();
    for (const date of dates.slice(0, -40)) delete store.days[date];
    const dailyDates = Object.keys(store.daily.FUTURES || {}).sort();
    for (const date of dailyDates.slice(0, -120)) delete store.daily.FUTURES[date];
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: store.version, days: store.days, daily: store.daily }));
    fs.renameSync(tmp, STORE_PATH);
  } catch (error) {
    console.warn('[KIS FLOW] persist failed:', error.message);
  }
}

function upsertMinute(kind, date, values, minuteText = null, extra = {}) {
  ensureStoreLoaded();
  const clock = getKoreaClock();
  const hhmm = minuteText || clock.hhmm;
  const start = kind === 'FUTURES' ? '08:45' : '09:00';
  const end = kind === 'FUTURES' ? '15:45' : '15:30';
  if (hhmm < start || hhmm > end) return;
  const row = { date: `${date} ${hhmm}`, ...values, ...extra };
  if (!store.days[date]) store.days[date] = {};
  const rows = Array.isArray(store.days[date][kind]) ? store.days[date][kind] : [];
  const idx = rows.findIndex((item) => item.date === row.date);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  store.days[date][kind] = rows
    .filter((item) => item.date >= `${date} ${start}` && item.date <= `${date} ${end}`)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-450);
  if (kind === 'FUTURES' && Number.isFinite(Number(values.foreign))) {
    if (!store.daily.FUTURES) store.daily.FUTURES = {};
    store.daily.FUTURES[date] = Number(values.foreign);
  }
}

function getRows(kind, date) {
  ensureStoreLoaded();
  return Array.isArray(store.days?.[date]?.[kind])
    ? [...store.days[date][kind]].sort((a, b) => a.date.localeCompare(b.date))
    : [];
}

function normalizeBackfillRows(payload, kind, date) {
  if (payload?.unit !== (kind === 'FUTURES' ? '계약' : '조원') || !String(payload?.source || '').includes('kis-persisted')) return [];
  const values = kind === 'FUTURES' ? ['foreign'] : ['foreign', 'institution', 'individual'];
  const start = kind === 'FUTURES' ? '08:45' : '09:00';
  const end = kind === 'FUTURES' ? '15:45' : '15:30';
  const seen = new Map();
  for (const row of Array.isArray(payload.series) ? payload.series : []) {
    const timestamp = String(row?.date || '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timestamp) || timestamp < `${date} ${start}` || timestamp > `${date} ${end}`) continue;
    if (values.some((field) => row[field] === null || row[field] === undefined || row[field] === '')) continue;
    const numeric = Object.fromEntries(values.map((field) => [field, Number(row[field])]));
    if (!Object.values(numeric).every(Number.isFinite)) continue;
    seen.set(timestamp, { date: timestamp, ...numeric, observed: true });
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function captureMarketsForMinute(minutes, isOpenToday) {
  if (!isOpenToday) return [];
  return [
    ...(minutes >= 9 * 60 && minutes <= 15 * 60 + 30 ? ['KOSPI', 'KOSDAQ'] : []),
    ...(minutes >= 8 * 60 + 45 && minutes <= 15 * 60 + 45 ? ['FUTURES'] : []),
  ];
}

async function backfillIntradayRows(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const needsBackfill = Object.keys(BACKFILL_KINDS).some((kind) => {
    const rows = getRows(kind, date);
    return !rows.length || rows[0].date > `${date} 09:01`;
  });
  if (!needsBackfill) return;
  if (state.backfillPromise) return state.backfillPromise;
  if (state.backfillDate === date && Date.now() - state.backfillAt < 5 * 60_000) return;
  state.backfillDate = date;
  state.backfillAt = Date.now();
  state.backfillPromise = (async () => {
    const results = await Promise.allSettled(Object.entries(BACKFILL_KINDS).map(async ([kind, apiKind]) => {
      const url = `${BACKFILL_BASE_URL.replace(/\/$/, '')}/api/extra-chart?kind=${apiKind}`;
      const response = await fetch(url, { headers:require('./access-control').requestHeaders(), redirect:'error', signal: AbortSignal.timeout(6_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = normalizeBackfillRows(await response.json(), kind, date);
      if (rows.length < 2) return false;
      const existing = getRows(kind, date);
      // Locally observed values take precedence at matching timestamps.
      const merged = new Map([...rows, ...existing].map((row) => [row.date, row]));
      if (merged.size === existing.length) return false;
      if (!store.days[date]) store.days[date] = {};
      store.days[date][kind] = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-450);
      if (kind === 'FUTURES') store.daily.FUTURES[date] = Number(store.days[date][kind].at(-1).foreign);
      return true;
    }));
    if (results.some((result) => result.status === 'fulfilled' && result.value)) persistStore();
  })().finally(() => { state.backfillPromise = null; });
  return state.backfillPromise;
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`KIS HTTP ${response.status}`),{kisCode:/^[A-Z0-9_]{1,32}$/.test(String(json.msg_cd))?json.msg_cd:`HTTP_${response.status}`});
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  return require('./kis-market-data').getAccessToken();
}
async function getAccessTokenInfo() {
  return require('./kis-market-data').getTokenInfo();
}

function kisHeaders(token, trId) {
  const { appKey, appSecret } = getKisCredentials();
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: 'P',
  };
}

async function kisGet(apiPath, trId, params) {
  if(!hasKisCredentials())throw Object.assign(new Error('KIS 환경변수 미설정'),{kisCode:'NOT_CONFIGURED'});
  const token = await getAccessToken();
  const url = new URL(apiPath, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value ?? ''));
  const json = await fetchJson(url, { method: 'GET', headers: kisHeaders(token, trId) }, 12_000);
  if (String(json.rt_cd ?? '0') !== '0') {
    throw Object.assign(new Error(`${trId} 요청 실패`),{kisCode:/^[A-Z0-9_]{1,32}$/.test(String(json.msg_cd))?json.msg_cd:'API_ERROR'});
  }
  return json;
}

let sessionDateReader;
async function getLatestOpenDate(force = false) {
  if(!sessionDateReader)sessionDateReader=require('./kis-session-date').createSessionDateReader({
    request:kisGet,clock:getKoreaClock,
    publishedDate:async()=>{
      const response=await fetch('https://finance.daum.net/api/market_index/days?page=1&perPage=1&market=KOSPI&pagination=true',{
        headers:{'User-Agent':'Mozilla/5.0',Referer:'https://finance.daum.net/'},signal:AbortSignal.timeout(8_000)
      });
      if(!response.ok)throw new Error('시장 개장일 보조 조회 실패');
      const json=await response.json();return String(json?.data?.[0]?.date||'').slice(0,10);
    }
  });
  const latest=await sessionDateReader.latest(force);
  state.latestOpenDate=latest;
  return latest;
}

const INVESTOR_MARKETS = {
  KOSPI: { market: 'KSP', subCode: '0001', unit: '조원' },
  KOSDAQ: { market: 'KSQ', subCode: '1001', unit: '조원' },
  FUTURES: { market: 'K2I', subCode: 'F001', unit: '계약' },
};

function parseInvestorSnapshot(json, kind) {
  const rows = Array.isArray(json?.output) ? json.output : (json?.output ? [json.output] : []);
  let row = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const candidate = rows[i] || {};
    if (kind === 'FUTURES') {
      if (Number.isFinite(toNumber(candidate.frgn_ntby_qty))) { row = candidate; break; }
    } else if ([candidate.frgn_ntby_tr_pbmn, candidate.orgn_ntby_tr_pbmn, candidate.prsn_ntby_tr_pbmn].some((v) => Number.isFinite(toNumber(v)))) {
      row = candidate;
      break;
    }
  }
  if (!row) throw new Error(`KIS ${kind} output did not contain usable investor fields`);
  if (kind === 'FUTURES') {
    const foreign = toNumber(row.frgn_ntby_qty);
    if (!Number.isFinite(foreign)) throw new Error('KIS KOSPI200 futures foreign net quantity unavailable');
    return { foreign };
  }
  const values = {
    foreign: pbmnToTrillion(row.frgn_ntby_tr_pbmn),
    institution: pbmnToTrillion(row.orgn_ntby_tr_pbmn),
    individual: pbmnToTrillion(row.prsn_ntby_tr_pbmn),
  };
  if (!Object.values(values).every(Number.isFinite)) throw new Error(`KIS ${kind} investor amount unavailable`);
  return values;
}

async function fetchInvestorSnapshot(kind) {
  const cfg = INVESTOR_MARKETS[kind];
  if (!cfg) throw new Error(`Unknown investor market ${kind}`);
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market', 'FHPTJ04030000', {
    FID_INPUT_ISCD: cfg.market,
    FID_INPUT_ISCD_2: cfg.subCode,
  });
  return parseInvestorSnapshot(json, kind);
}

function safeInvestorError(error) {
  const code = String(error?.kisCode || error?.code || 'SOURCE_ERROR');
  return /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'SOURCE_ERROR';
}

async function refreshInvestorMarket(kind, date) {
  const clock = getKoreaClock();
  const start=kind==='FUTURES'?8*60+45:9*60,end=kind==='FUTURES'?15*60+45:15*60+30;
  if (!hasKisCredentials() || date !== clock.date || !INVESTOR_MARKETS[kind] ||
      clock.minutes < start || clock.minutes > end) return;
  const key = `${kind}:${date}`;
  // A chart visitor joins its market's request instead of returning old rows
  // while an unrelated futures/program collection is still running.
  if (investorRequests.has(key)) return investorRequests.get(key);
  const previous = state.investorRefresh[kind];
  if (previous?.date === date && Date.now() - previous.attemptMs < INVESTOR_REFRESH_MS) return;
  const status = { date, attemptMs:Date.now(), lastAttemptAt:nowIso(), lastSuccessAt:previous?.date === date ? previous.lastSuccessAt || '' : '', code:'' };
  state.investorRefresh[kind] = status;
  const request = (async () => {
    try {
      const values = await fetchInvestorSnapshot(kind);
      const observed = getKoreaClock();
      if (observed.date !== date || observed.minutes < start || observed.minutes > end) return;
      upsertMinute(kind, date, values, observed.hhmm, { observed:true });
      status.lastSuccessAt = nowIso();
      state.lastResults[kind] = { ok:true, values };
      state.lastSuccessAt = status.lastSuccessAt;
      persistStore();
      return values;
    } catch (error) {
      status.code = safeInvestorError(error);
      state.lastResults[kind] = { ok:false, error:status.code };
      state.lastErrorAt = nowIso();
    }
  })().finally(() => investorRequests.delete(key));
  investorRequests.set(key, request);
  return request;
}

function investorFreshness(kind, date, rows) {
  const clock = getKoreaClock(), lastDataAt = rows.at(-1)?.date || '';
  const live = date === clock.date && clock.minutes >= (kind==='FUTURES'?8*60+45:9*60) && clock.minutes <= (kind==='FUTURES'?15*60+45:15*60+30);
  const elapsed = lastDataAt ? Date.now() - Date.parse(`${lastDataAt.replace(' ', 'T')}:00+09:00`) : Infinity;
  const status = state.investorRefresh[kind];
  const current = status?.date === date ? status : {};
  return { lastDataAt, stale:live && (!Number.isFinite(elapsed) || elapsed > 120_000),
    lastAttemptAt:current.lastAttemptAt || '', lastSuccessAt:current.lastSuccessAt || '', refreshError:current.code || (hasKisCredentials()?'':'NOT_CONFIGURED') };
}

async function fetchSpotDailyFinal(kind, date) {
  const cfg = kind === 'KOSDAQ'
    ? { market: 'KSQ', code: '1001' }
    : { market: 'KSP', code: '0001' };
  const ymd = date.replace(/-/g, '');
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market', 'FHPTJ04040000', {
    FID_COND_MRKT_DIV_CODE: 'U',
    FID_INPUT_ISCD: cfg.code,
    FID_INPUT_DATE_1: ymd,
    FID_INPUT_ISCD_1: cfg.market,
    FID_INPUT_DATE_2: ymd,
    FID_INPUT_ISCD_2: cfg.code,
  });
  const rows = Array.isArray(json.output) ? json.output : (json.output ? [json.output] : []);
  const row = rows.find((item) => String(item?.stck_bsop_date || '').replace(/\D/g, '') === ymd);
  if (!row) throw new Error(`KIS ${kind} daily final unavailable`);
  const values = {
    foreign: pbmnToTrillion(row.frgn_ntby_tr_pbmn),
    institution: pbmnToTrillion(row.orgn_ntby_tr_pbmn),
    individual: pbmnToTrillion(row.prsn_ntby_tr_pbmn),
  };
  if (!Object.values(values).every(Number.isFinite)) throw new Error(`KIS ${kind} daily final fields unavailable`);
  return values;
}

let programReader;
function getProgramReader() {
  if(!programReader)programReader=require('./kis-program-data').createProgramReader({request:kisGet});
  return programReader;
}
function parseProgramCurrentRows(json) {return require('./kis-program-data').parseCurrent(json);}
function parseProgramDailyRows(json) {return require('./kis-program-data').parseDaily(json);}
async function fetchProgramCurrentRows() {return getProgramReader().current();}

async function captureOnce() {
  if (state.pollRunning || !hasKisCredentials()) return;
  state.pollRunning = true;
  state.lastPollAt = nowIso();
  try {
    const clock = getKoreaClock();
    const latestOpenDate = await getLatestOpenDate();
    const isOpenToday = latestOpenDate === clock.date;
    const activeKinds = captureMarketsForMinute(clock.minutes, isOpenToday);
    const inSpotSession = activeKinds.includes('KOSPI');
    if (isOpenToday && clock.minutes >= 15 * 60 + 32) {
      await refreshClosingAuction(latestOpenDate);
    }
    if (!activeKinds.length) return;

    const tasks = activeKinds.map((kind) => [kind, () => refreshInvestorMarket(kind, latestOpenDate)]);
    const results = {};
    for (const [kind, fn] of tasks) {
      try {
        const values = await fn();
        if (values) results[kind] = { ok: true, values };
      } catch (error) {
        results[kind] = { ok: false, error: error.message };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    // Program API returns the most recent ~30 minutes. Upsert every row so a short outage can be backfilled.
    if (inSpotSession) {
      try {
        const programRows = (await fetchProgramCurrentRows('K')).filter(row=>
          (!row.date||row.date===latestOpenDate)&&Number(row.hour.slice(0,2))*60+Number(row.hour.slice(2,4))<=clock.minutes);
        for (const row of programRows) upsertMinute('PROGRAM', latestOpenDate, { value: row.value }, row.hhmm);
        results.PROGRAM = { ok: true, rows: programRows.length, latest: programRows.at(-1) || null };
      } catch (error) {
        results.PROGRAM = { ok: false, error: error.message };
      }
    }

    state.lastResults = { ...state.lastResults, ...results };
    const anySuccess = Object.values(results).some((item) => item?.ok);
    if (anySuccess) {
      state.lastSuccessAt = nowIso();
      state.lastError = '';
    }
    persistStore();
  } catch (error) {
    state.lastErrorAt = nowIso();
    state.lastError = error.message;
    console.error('[KIS FLOW] capture error:', error.message);
  } finally {
    state.pollRunning = false;
  }
}

async function refreshClosingAuction(date) {
  const clock = getKoreaClock();
  if (!hasKisCredentials() || date !== clock.date || clock.minutes < 15 * 60 + 32) return;
  if (state.closingPromise) return state.closingPromise;
  const rules = [
    { kind: 'KOSPI', close: '15:30', begin: 15 * 60 + 32, settle: '15:35' },
    { kind: 'KOSDAQ', close: '15:30', begin: 15 * 60 + 32, settle: '15:35' },
    { kind: 'FUTURES', close: '15:45', begin: 15 * 60 + 47, settle: '15:50' },
  ];
  const due = rules.filter(({ kind, close, begin, settle }) => {
    if (clock.minutes < begin) return false;
    const row = getRows(kind, date).find((item) => item.date === `${date} ${close}`);
    if (row?.final && Date.parse(row.confirmedAt || '') >= new Date(`${date}T${settle}:00+09:00`).getTime()) return false;
    const interval = clock.hhmm <= settle ? 30_000 : 5 * 60_000;
    return Date.now() - (state.lastClosingPollAt[kind] || 0) >= interval;
  });
  if (!due.length) return;
  for (const { kind } of due) state.lastClosingPollAt[kind] = Date.now();
  state.closingPromise = (async () => {
    // Acquire one token first so parallel KIS requests do not issue three tokens.
    await getAccessToken();
    const results = await Promise.allSettled(due.map(async ({ kind, close }) => {
      const values = await fetchInvestorSnapshot(kind);
      if(getKoreaClock().date!==date)throw new Error('마감 수급 응답 중 거래일이 변경되었습니다.');
      upsertMinute(kind, date, values, close, { final: true, confirmedAt: nowIso() });
      return { kind, values };
    }));
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    if (succeeded.length) {
      persistStore();
      state.lastSuccessAt = nowIso();
    }
    state.lastResults.CLOSING = Object.fromEntries(results.map((result, index) => [
      due[index].kind, result.status === 'fulfilled'
        ? { ok: true, confirmedAt: nowIso() }
        : { ok: false, error: result.reason?.message || 'closing snapshot failed' },
    ]));
  })().finally(() => { state.closingPromise = null; });
  return state.closingPromise;
}

async function ensureLatestDateFallbacks() {
  if (!hasKisCredentials()) return;
  ensureStoreLoaded();
  const latestDate = await getLatestOpenDate();
  const clock = getKoreaClock();
  // A daily closing value is not an intraday minute and must never be placed
  // at 15:30 before the current session has actually closed.
  if (latestDate === clock.date && clock.minutes < 15 * 60 + 32) return;
  if (latestDate === clock.date) await refreshClosingAuction(latestDate).catch(() => {});
  let changed = false;

  for (const kind of ['KOSPI', 'KOSDAQ']) {
    const closingRow = getRows(kind, latestDate).find((row) => row.date === `${latestDate} 15:30`);
    if (closingRow?.final) continue;
    const fallbackKey=`${kind}:${latestDate}`;
    if(Date.now()-(state.dailyFallbackAt[fallbackKey]||0)<20_000)continue;
    state.dailyFallbackAt[fallbackKey]=Date.now();
    try {
      const values = await fetchSpotDailyFinal(kind, latestDate);
      upsertMinute(kind, latestDate, values, '15:30', { final: true, fallback: 'KIS daily final' });
      changed = true;
    } catch (error) {
      console.error(`[KIS FLOW] ${kind} daily fallback failed:`, error.message);
    }
  }

  if (latestDate === clock.date && clock.minutes >= 15 * 60 + 47 && !getRows('FUTURES', latestDate).length) {
    try {
      const values = await fetchInvestorSnapshot('FUTURES');
      upsertMinute('FUTURES', latestDate, values, '15:45', { final: true, fallback: 'KIS latest snapshot' });
      changed = true;
    } catch (error) {
      console.error('[KIS FLOW] FUTURES fallback failed:', error.message);
    }
  }

  if (changed) persistStore();
}

async function buildInvestorChart(kind) {
  const latestDate = await getLatestOpenDate();
  await refreshInvestorMarket(kind, latestDate);
  // An old curve can be backfilled separately; it must not delay the live market read.
  void backfillIntradayRows(latestDate).catch(() => {});
  const clock = getKoreaClock();
  if (latestDate === clock.date && clock.minutes >= 15 * 60 + 32) {
    await refreshClosingAuction(latestDate).catch(() => {});
  }
  let rows = getRows(kind, latestDate);
  if (!rows.length || (latestDate===clock.date && clock.minutes>=15*60+32 && !rows.some(row=>row.date===`${latestDate} 15:30`&&row.final))) {
    await ensureLatestDateFallbacks().catch(() => {});
    rows = getRows(kind, latestDate);
  }
  const label = kind === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const freshness = investorFreshness(kind, latestDate, rows);
  const configured=hasKisCredentials();
  return {
    ok: true,
    unit: '조원',
    source: configured?'KIS FHPTJ04030000':rows.length?'KIS 저장 수급':'unavailable',
    kisConfigured:configured,
    latestOpenDate: latestDate,
    displayDate: latestDate,
    ...freshness,
    note: configured?`${label} KIS 실제 순매수 · 최근 개장일 ${latestDate} · 20초 조회/1분 저장 · 마지막 수집 ${freshness.lastDataAt || '없음'}${freshness.stale ? ' · 갱신 지연' : ''}${freshness.refreshError ? ` · KIS 조회 오류 ${freshness.refreshError}` : ''}${rows.at(-1)?.confirmedAt ? ' · 15:30 동시호가 반영' : ''}`:
      `${label} 수급 갱신 중지 · stock3 실행 서비스의 KIS API 키 환경변수가 설정되지 않았습니다(NOT_CONFIGURED). · 기준 개장일 ${latestDate}${rows.length?' · 저장된 수급만 표시합니다.':''}`,
    series: rows,
  };
}

async function buildFuturesChart() {
  const latestDate = await getLatestOpenDate();
  await refreshInvestorMarket('FUTURES',latestDate);
  void backfillIntradayRows(latestDate).catch(() => {});
  const clock = getKoreaClock();
  if (latestDate === clock.date && clock.minutes >= 15 * 60 + 47) {
    await refreshClosingAuction(latestDate).catch(() => {});
  }
  let rows = getRows('FUTURES', latestDate);
  if (!rows.length) {
    await ensureLatestDateFallbacks().catch(() => {});
    rows = getRows('FUTURES', latestDate);
  }
  const freshness=investorFreshness('FUTURES',latestDate,rows);
  const configured=hasKisCredentials();
  return {
    ok: true,
    unit: '계약',
    source: configured?'KIS FHPTJ04030000 K2I/F001':rows.length?'KIS 저장 수급':'unavailable',
    kisConfigured:configured,
    latestOpenDate: latestDate,
    displayDate: latestDate,
    ...freshness,
    note: configured?`KOSPI200 선물 외국인 순매수 · 최근 개장일 ${latestDate} · 20초 조회/1분 저장 · 마지막 수집 ${freshness.lastDataAt||'없음'} · 08:45~15:45${rows.at(-1)?.final?' · 15:45 장마감 반영':''}${freshness.stale?' · 갱신 지연':''}${freshness.refreshError?` · KIS 조회 오류 ${freshness.refreshError}`:''}${rows.length===1?' · 실제 관측 1점(과거 분봉 미수집)':''}`:
      `선물 수급 갱신 중지 · stock3 실행 서비스의 KIS API 키 환경변수가 설정되지 않았습니다(NOT_CONFIGURED). · 기준 개장일 ${latestDate}${rows.length?' · 저장된 수급만 표시합니다.':''}`,
    series: rows,
  };
}

async function buildFuturesDailyChart(days=120) {
  const latestDate=await getLatestOpenDate();
  await refreshInvestorMarket('FUTURES',latestDate);
  await ensureLatestDateFallbacks().catch(()=>{});
  const limit=Math.max(1,Math.min(120,Math.floor(Number(days)||120)));
  const daily=Object.entries(store.daily.FUTURES||{}).map(([date,value])=>({date,value:numericOrNull(value)}))
    .filter(row=>row.date<=latestDate&&row.value!==null).sort((a,b)=>a.date.localeCompare(b.date)).slice(-limit);
  let total=0;
  const series=daily.map(row=>({date:row.date,dailyForeign:row.value,foreign:total+=row.value}));
  return {ok:true,unit:'계약',source:'KIS FHPTJ04030000 K2I/F001',latestOpenDate:latestDate,
    displayDate:daily.at(-1)?.date||'',series,
    note:`KOSPI200 선물 외국인 일별 순매수 · 최근 개장일 ${latestDate} · 마지막 자료 ${daily.at(-1)?.date||'없음'} · 단위 계약 · 실제 수집한 ${daily.length}거래일${daily.at(-1)?.date!==latestDate?' · 최근 개장일 자료 확인 중':''}`};
}

async function buildFlowStats() {
  ensureStoreLoaded();
  const latestDate = await getLatestOpenDate();
  await refreshInvestorMarket('FUTURES',latestDate);
  // Persist a final futures value for the latest open day before calculating
  // windows. This also covers a process restart after the regular session.
  await ensureLatestDateFallbacks().catch(() => {});

  const program=await getProgramReader().summary(latestDate,getKoreaClock());
  state.programDiagnostics=program.diagnostics;

  const futuresRows = Object.entries(store.daily.FUTURES || {})
    .map(([date, value]) => ({ date, value: numericOrNull(value) }))
    .filter((row) => row.date <= latestDate && row.value !== null && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    latestOpenDate: latestDate,
    futuresMode: 'futures',
    futuresUnit: '계약',
    futuresArray: futuresRows.at(-1)?.date===latestDate?sumWindows(futuresRows):null,
    futuresLatest: futuresRows.length ? {value:futuresRows.at(-1).value,unit:'계약',asOf:futuresRows.at(-1).date,source:'KIS'} : null,
    progsArray: program.values,
    futuresCoverageDays: futuresRows.length,
    programCoverageDays: program.coverageDays,
    programAsOfDate: program.asOfDate,
    programAsOfHour: program.asOfHour,
    programError: program.error,
    programDiagnostics: program.diagnostics,
    programSource: program.source,
  };
}

function normalizeApiPath(pathname) {
  const match = String(pathname || '').match(/^\/[^/]+(\/api\/.*)$/);
  return match ? match[1] : pathname;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function coreRequest(req, collect = false) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `${CORE_HOST}:${CORE_PORT}` };
    const proxy = http.request({
      host: CORE_HOST,
      port: CORE_PORT,
      method: req.method,
      path: req.url,
      headers,
    }, (coreRes) => {
      if (!collect) return resolve({ proxy, coreRes });
      const chunks = [];
      coreRes.on('data', (chunk) => chunks.push(chunk));
      coreRes.on('end', () => resolve({
        statusCode: coreRes.statusCode || 200,
        headers: coreRes.headers,
        body: Buffer.concat(chunks),
      }));
    });
    proxy.on('error', reject);
    if (collect) {
      req.pipe(proxy);
    } else {
      resolve({ proxy });
    }
  });
}

async function fetchCoreJson(req) {
  return new Promise((resolve, reject) => {
    const proxy = http.request({
      host: CORE_HOST,
      port: CORE_PORT,
      method: 'GET',
      path: req.url,
      headers: { ...req.headers, host: `${CORE_HOST}:${CORE_PORT}` },
    }, (coreRes) => {
      const chunks = [];
      coreRes.on('data', (chunk) => chunks.push(chunk));
      coreRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`core /api/stats returned non-JSON: ${body.slice(0, 160)}`)); }
      });
    });
    proxy.on('error', reject);
    proxy.setTimeout(15_000,()=>proxy.destroy(Object.assign(new Error('거래대금 보조 조회 지연'),{code:'CORE_TIMEOUT'})));
    proxy.end();
  });
}

function proxyToCore(req, res) {
  const headers = { ...req.headers, host: `${CORE_HOST}:${CORE_PORT}` };
  const proxy = http.request({
    host: CORE_HOST,
    port: CORE_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (coreRes) => {
    res.writeHead(coreRes.statusCode || 200, coreRes.headers);
    coreRes.pipe(res);
  });
  proxy.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `stock3 core unavailable: ${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxy);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const apiPath = normalizeApiPath(url.pathname);
  if (apiPath.startsWith('/api/') && !require('./access-control').requireAccess(req,res)) return;

  try {
    if (apiPath === '/api/kis-flow-health') {
      ensureStoreLoaded();
      const latestOpenDate = hasKisCredentials() ? await getLatestOpenDate().catch(() => state.latestOpenDate || '') : '';
      return sendJson(res, 200, {
        ok: true,
        configured: hasKisCredentials(),
        latestOpenDate,
        lastPollAt: state.lastPollAt,
        lastSuccessAt: state.lastSuccessAt,
        lastErrorAt: state.lastErrorAt,
        lastError: state.lastError,
        lastResults: state.lastResults,
        programDiagnostics: state.programDiagnostics || null,
        investorStatus: latestOpenDate ? {
          kospi: investorFreshness('KOSPI', latestOpenDate, getRows('KOSPI', latestOpenDate)),
          kosdaq: investorFreshness('KOSDAQ', latestOpenDate, getRows('KOSDAQ', latestOpenDate)),
          futures: investorFreshness('FUTURES', latestOpenDate, getRows('FUTURES', latestOpenDate)),
        } : {},
        rows: latestOpenDate ? {
          kospi: getRows('KOSPI', latestOpenDate).length,
          kosdaq: getRows('KOSDAQ', latestOpenDate).length,
          futures: getRows('FUTURES', latestOpenDate).length,
          program: getRows('PROGRAM', latestOpenDate).length,
        } : {},
        futuresDailyCoverage: Object.keys(store.daily.FUTURES || {}).length,
        corePort: CORE_PORT,
      });
    }

    if (apiPath === '/api/extra-chart') {
      const kind = url.searchParams.get('kind') || '';
      if (kind === 'kospi-investor-minute') return sendJson(res, 200, await buildInvestorChart('KOSPI'));
      if (kind === 'kosdaq-investor-minute') return sendJson(res, 200, await buildInvestorChart('KOSDAQ'));
      if (kind === 'foreign-futures-minute') return sendJson(res, 200, await buildFuturesChart());
      if (kind === 'foreign-futures-daily' && hasKisCredentials()) return sendJson(res,200,await buildFuturesDailyChart(url.searchParams.get('days')));
    }

    if (apiPath === '/api/stats') {
      const [coreResult, flowResult] = await Promise.allSettled([
        fetchCoreJson(req),
        buildFlowStats(),
      ]);
      const core = coreResult.status === 'fulfilled' ? coreResult.value : { ok: true };
      const flow = flowResult.status === 'fulfilled' ? flowResult.value : {
        programError:`KIS 수급 조회 확인: ${require('./kis-program-data').safeCode(flowResult.reason)}`
      };
      return sendJson(res, 200, {
        ...mergeFlowStats(core, flow, {preferKis:hasKisCredentials()}),
        ok: true,
        kisConfigured: hasKisCredentials(),
        latestOpenDate: !hasKisCredentials() && core.futuresMode === 'spot-fallback'
          ? core.latestOpenDate || flow?.latestOpenDate || ''
          : flow?.latestOpenDate || core.latestOpenDate || '',
      });
    }

    return proxyToCore(req, res);
  } catch (error) {
    state.lastErrorAt = nowIso();
    state.lastError = error.message;
    console.error('[KIS FLOW] request error:', error);
    return sendJson(res, 500, { ok: false, error: error.message });
  }
}

function spawnCore() {
  const childEnv = { ...process.env, PORT: String(CORE_PORT), STOCK3_KIS_FLOW_OWNER:'gateway' };
  // Share environment credentials with quote/chart readers; the gateway still owns flow collection.
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['inherit','inherit','inherit','ipc'],
  });
  child.on('message',async(message)=>{
    if(message?.type!=='stock3-kis-auth-request'||typeof message.requestId!=='string')return;
    let value='',expiresAt=0;
    try{({value,expiresAt}=await getAccessTokenInfo());}catch(_){ /* send no credential details on failure */ }
    if(child.connected)child.send({type:'stock3-kis-auth-result',requestId:message.requestId,value,expiresAt},()=>{});
  });
  child.on('spawn', () => { state.coreReady = true; });
  child.on('exit', (code, signal) => {
    state.coreReady = false;
    console.error(`[KIS FLOW] core server exited code=${code} signal=${signal || ''}`);
    if (!shuttingDown) process.exit(code || 1);
  });
  return child;
}

let child = null;
let shuttingDown = false;
let pollTimer = null;
let fallbackTimer = null;
let gatewayServer = null;

function start() {
  loadKisCredentials();
  ensureStoreLoaded();
  child = spawnCore();
  gatewayServer = http.createServer((req, res) => void handleRequest(req, res));
  gatewayServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[KIS FLOW] gateway listening on http://127.0.0.1:${PORT}; core=${CORE_PORT}`);
    console.log(`[KIS FLOW] credentials configured: ${hasKisCredentials() ? 'YES' : 'NO'}`);
    setTimeout(() => captureOnce().catch(() => {}), 1500).unref?.();
    setTimeout(() => ensureLatestDateFallbacks().catch(() => {}), 3000).unref?.();
  });
  pollTimer = setInterval(() => captureOnce().catch(() => {}), POLL_MS);
  pollTimer.unref?.();
  fallbackTimer = setInterval(() => ensureLatestDateFallbacks().catch(() => {}), 15 * 60 * 1000);
  fallbackTimer.unref?.();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[KIS FLOW] shutting down (${signal})`);
  if (pollTimer) clearInterval(pollTimer);
  if (fallbackTimer) clearInterval(fallbackTimer);
  try { child?.kill('SIGTERM'); } catch (_) {}
  if (gatewayServer) gatewayServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) start();

module.exports = {
  backfillIntradayRows,
  captureMarketsForMinute,
  getRows,
  normalizeBackfillRows,
  parseInvestorSnapshot,
  parseProgramCurrentRows,
  parseProgramDailyRows,
  sumWindows,
  mergeWindowValues,
  pbmnToTrillion,
  pbmnToEok,
  INVESTOR_MARKETS,
};
