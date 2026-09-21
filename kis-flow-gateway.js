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

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8000);
const CORE_PORT = Number(process.env.STOCK3_CORE_PORT || (PORT + 10000));
const CORE_HOST = '127.0.0.1';
const STORE_PATH = process.env.KIS_FLOW_STORE_PATH || path.join(ROOT, '.runtime', 'kis-flow-gateway.json');
const LEGACY_STORE_PATH = process.env.INVESTOR_INTRADAY_STORE_PATH || path.join(ROOT, '.runtime', 'investor-intraday.json');
const KIS_BASE_URL = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
const POLL_MS = Math.max(30_000, Number(process.env.KIS_FLOW_POLL_MS || 30_000));

const state = {
  token: '',
  tokenExpiresAt: 0,
  holidayDate: '',
  latestOpenDate: '',
  holidayExpiresAt: 0,
  pollRunning: false,
  lastPollAt: '',
  lastSuccessAt: '',
  lastErrorAt: '',
  lastError: '',
  lastResults: {},
  coreReady: false,
};

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
    console.error('[KIS FLOW] persist failed:', error.message);
  }
}

function upsertMinute(kind, date, values, minuteText = null, extra = {}) {
  ensureStoreLoaded();
  const clock = getKoreaClock();
  const hhmm = minuteText || clock.hhmm;
  if (hhmm < '09:00' || hhmm > '15:30') return;
  const row = { date: `${date} ${hhmm}`, ...values, ...extra };
  if (!store.days[date]) store.days[date] = {};
  const rows = Array.isArray(store.days[date][kind]) ? store.days[date][kind] : [];
  const idx = rows.findIndex((item) => item.date === row.date);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  store.days[date][kind] = rows
    .filter((item) => item.date >= `${date} 09:00` && item.date <= `${date} 15:30`)
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

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${json.msg1 || json.message || 'request failed'}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  if (!hasKisCredentials()) throw new Error('KIS APP KEY/SECRET environment variables are not configured');
  if (state.token && state.tokenExpiresAt - Date.now() > 120_000) return state.token;
  const { appKey, appSecret } = getKisCredentials();
  const json = await fetchJson(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  }, 12_000);
  if (!json.access_token) throw new Error(`KIS token failed: ${json.msg_cd || json.msg1 || 'no access_token'}`);
  state.token = json.access_token;
  state.tokenExpiresAt = Date.now() + Math.max(300, Number(json.expires_in) || 3600) * 1000;
  return state.token;
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
  const token = await getAccessToken();
  const url = new URL(apiPath, KIS_BASE_URL);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value ?? ''));
  const json = await fetchJson(url, { method: 'GET', headers: kisHeaders(token, trId) }, 12_000);
  if (String(json.rt_cd ?? '0') !== '0') {
    throw new Error(`${trId} ${json.msg_cd || ''} ${json.msg1 || 'KIS API error'}`.trim());
  }
  return json;
}

async function getLatestOpenDate(force = false) {
  const clock = getKoreaClock();
  if (!force && state.holidayDate === clock.date && state.latestOpenDate && state.holidayExpiresAt > Date.now()) {
    return state.latestOpenDate;
  }
  const baseDate = shiftKoreaDate(clock.date, -14).replace(/-/g, '');
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/chk-holiday', 'CTCA0903R', {
    BASS_DT: baseDate,
    CTX_AREA_FK: '',
    CTX_AREA_NK: '',
  });
  const rows = Array.isArray(json.output) ? json.output : (json.output ? [json.output] : []);
  const today = clock.ymd;
  const openDates = rows
    .filter((row) => String(row?.opnd_yn || '').toUpperCase() === 'Y')
    .map((row) => String(row?.bass_dt || '').replace(/\D/g, ''))
    .filter((date) => /^\d{8}$/.test(date) && date <= today)
    .sort();
  const latest = ymdToDashed(openDates.at(-1));
  if (!latest) throw new Error('KIS holiday API returned no recent open date');
  state.holidayDate = clock.date;
  state.latestOpenDate = latest;
  state.holidayExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
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
  const row = rows.find((item) => String(item?.stck_bsop_date || '').replace(/\D/g, '') === ymd) || rows[0];
  if (!row) throw new Error(`KIS ${kind} daily final unavailable`);
  const values = {
    foreign: pbmnToTrillion(row.frgn_ntby_tr_pbmn),
    institution: pbmnToTrillion(row.orgn_ntby_tr_pbmn),
    individual: pbmnToTrillion(row.prsn_ntby_tr_pbmn),
  };
  if (!Object.values(values).every(Number.isFinite)) throw new Error(`KIS ${kind} daily final fields unavailable`);
  return values;
}

function parseProgramCurrentRows(json) {
  // KIS official sample uses body.output (not output1) for FHPPG04600101.
  const rows = Array.isArray(json?.output) ? json.output : (json?.output ? [json.output] : []);
  return rows.map((row) => {
    const rawHour = String(row?.bsop_hour || '').replace(/\D/g, '');
    const value = pbmnToEok(row?.whol_smtn_ntby_tr_pbmn);
    return {
      hour: rawHour,
      hhmm: /^\d{6}$/.test(rawHour) ? `${rawHour.slice(0, 2)}:${rawHour.slice(2, 4)}` : '',
      value,
    };
  }).filter((row) => /^\d{6}$/.test(row.hour) && row.hour >= '090000' && row.hour <= '153000' && Number.isFinite(row.value))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

async function fetchProgramCurrentRows(marketClass = 'K') {
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/comp-program-trade-today', 'FHPPG04600101', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_MRKT_CLS_CODE: marketClass,
    FID_SCTN_CLS_CODE: '',
    FID_INPUT_ISCD: '',
    FID_COND_MRKT_DIV_CODE1: '',
    FID_INPUT_HOUR_1: '',
  });
  return parseProgramCurrentRows(json);
}

function parseProgramDailyRows(json) {
  const rows = Array.isArray(json?.output) ? json.output : (json?.output ? [json.output] : []);
  const map = new Map();
  for (const row of rows) {
    const date = ymdToDashed(row?.stck_bsop_date);
    const value = pbmnToEok(row?.whol_smtn_ntby_tr_pbmn);
    if (date && Number.isFinite(value)) map.set(date, value);
  }
  return [...map.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchProgramDailyRows(endDate, marketClass = 'K') {
  const startDate = shiftKoreaDate(endDate, -120);
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/comp-program-trade-daily', 'FHPPG04600001', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_MRKT_CLS_CODE: marketClass,
    FID_INPUT_DATE_1: startDate.replace(/-/g, ''),
    FID_INPUT_DATE_2: endDate.replace(/-/g, ''),
  });
  return parseProgramDailyRows(json);
}

function sumWindows(rows, windows = [1, 3, 5, 10, 20]) {
  const cleaned = rows.filter((row) => row && row.date && Number.isFinite(Number(row.value))).sort((a, b) => a.date.localeCompare(b.date));
  return windows.map((days) => {
    if (cleaned.length < days) return null;
    return Math.round(cleaned.slice(-days).reduce((sum, row) => sum + Number(row.value), 0));
  });
}

async function captureOnce() {
  if (state.pollRunning || !hasKisCredentials()) return;
  state.pollRunning = true;
  state.lastPollAt = nowIso();
  try {
    const clock = getKoreaClock();
    const latestOpenDate = await getLatestOpenDate();
    const isOpenToday = latestOpenDate === clock.date;
    const inRegularSession = isOpenToday && clock.minutes >= 9 * 60 && clock.minutes <= 15 * 60 + 30;
    if (!inRegularSession) return;

    const tasks = [
      ['KOSPI', () => fetchInvestorSnapshot('KOSPI')],
      ['KOSDAQ', () => fetchInvestorSnapshot('KOSDAQ')],
      ['FUTURES', () => fetchInvestorSnapshot('FUTURES')],
    ];
    const results = {};
    for (const [kind, fn] of tasks) {
      try {
        const values = await fn();
        upsertMinute(kind, latestOpenDate, values);
        results[kind] = { ok: true, values };
      } catch (error) {
        results[kind] = { ok: false, error: error.message };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    // Program API returns the most recent ~30 minutes. Upsert every row so a short outage can be backfilled.
    try {
      const programRows = await fetchProgramCurrentRows('K');
      for (const row of programRows) upsertMinute('PROGRAM', latestOpenDate, { value: row.value }, row.hhmm);
      results.PROGRAM = { ok: true, rows: programRows.length, latest: programRows.at(-1) || null };
    } catch (error) {
      results.PROGRAM = { ok: false, error: error.message };
    }

    state.lastResults = results;
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

async function ensureLatestDateFallbacks() {
  if (!hasKisCredentials()) return;
  ensureStoreLoaded();
  const latestDate = await getLatestOpenDate();
  let changed = false;

  for (const kind of ['KOSPI', 'KOSDAQ']) {
    if (getRows(kind, latestDate).length) continue;
    try {
      const values = await fetchSpotDailyFinal(kind, latestDate);
      upsertMinute(kind, latestDate, values, '15:30', { final: true, fallback: 'KIS daily final' });
      changed = true;
    } catch (error) {
      console.error(`[KIS FLOW] ${kind} daily fallback failed:`, error.message);
    }
  }

  if (!getRows('FUTURES', latestDate).length) {
    try {
      const values = await fetchInvestorSnapshot('FUTURES');
      upsertMinute('FUTURES', latestDate, values, '15:30', { final: true, fallback: 'KIS latest snapshot' });
      changed = true;
    } catch (error) {
      console.error('[KIS FLOW] FUTURES fallback failed:', error.message);
    }
  }

  if (changed) persistStore();
}

async function buildInvestorChart(kind) {
  const latestDate = await getLatestOpenDate();
  let rows = getRows(kind, latestDate);
  if (!rows.length) {
    await ensureLatestDateFallbacks().catch(() => {});
    rows = getRows(kind, latestDate);
  }
  const label = kind === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  return {
    ok: true,
    unit: '조원',
    source: 'KIS FHPTJ04030000',
    latestOpenDate: latestDate,
    note: rows.length > 1
      ? `${label} KIS 실제 누적 순매수 · 최근 개장일 ${latestDate} · 장중 30초 조회/1분 저장 · 09:00~15:30`
      : `${label} KIS 최근 개장일 ${latestDate} 종가 수급입니다. 완전한 분봉 곡선은 장중 30초 수집 후 누적 저장됩니다.`,
    series: rows,
  };
}

async function buildFuturesChart() {
  const latestDate = await getLatestOpenDate();
  let rows = getRows('FUTURES', latestDate);
  if (!rows.length) {
    await ensureLatestDateFallbacks().catch(() => {});
    rows = getRows('FUTURES', latestDate);
  }
  return {
    ok: true,
    unit: '계약',
    source: 'KIS FHPTJ04030000 K2I/F001',
    latestOpenDate: latestDate,
    note: rows.length > 1
      ? `KOSPI200 선물 외국인 누적 순매수 · 최근 개장일 ${latestDate} · 장중 30초 조회/1분 저장 · 09:00~15:30`
      : `KOSPI200 선물 최근 개장일 ${latestDate} KIS 최종 수급입니다. 완전한 분봉 곡선은 장중 30초 수집 후 누적 저장됩니다.`,
    series: rows,
  };
}

async function buildFlowStats() {
  ensureStoreLoaded();
  const latestDate = await getLatestOpenDate();

  // Program: KIS daily history + today's live KOSPI program value when the market is open.
  let programRows = await fetchProgramDailyRows(latestDate, 'K');
  const clock = getKoreaClock();
  if (latestDate === clock.date && clock.minutes >= 9 * 60 && clock.minutes <= 15 * 60 + 35) {
    try {
      const liveRows = await fetchProgramCurrentRows('K');
      const latestLive = liveRows.at(-1);
      if (latestLive && Number.isFinite(latestLive.value)) {
        const map = new Map(programRows.map((row) => [row.date, row.value]));
        map.set(latestDate, latestLive.value);
        programRows = [...map.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
      }
    } catch (_) {}
  }

  const futuresRows = Object.entries(store.daily.FUTURES || {})
    .map(([date, value]) => ({ date, value: Number(value) }))
    .filter((row) => row.date <= latestDate && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    latestOpenDate: latestDate,
    futuresArray: sumWindows(futuresRows),
    progsArray: sumWindows(programRows),
    futuresCoverageDays: futuresRows.length,
    programCoverageDays: programRows.length,
    programSource: 'KIS FHPPG04600001/FHPPG04600101',
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
    }

    if (apiPath === '/api/stats') {
      const [core, flow] = await Promise.all([
        fetchCoreJson(req).catch(() => ({ ok: true })),
        buildFlowStats(),
      ]);
      return sendJson(res, 200, {
        ...core,
        ok: true,
        kisConfigured: hasKisCredentials(),
        latestOpenDate: flow.latestOpenDate,
        futuresArray: flow.futuresArray,
        progsArray: flow.progsArray,
        futuresCoverageDays: flow.futuresCoverageDays,
        programCoverageDays: flow.programCoverageDays,
        programSource: flow.programSource,
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
  const childEnv = { ...process.env, PORT: String(CORE_PORT) };
  // Avoid duplicate KIS polling inside the legacy core; the gateway owns KIS flow collection.
  for (const key of ['KIS_APP_KEY', 'KIS_APPKEY', 'KIS_KEY', 'APP_KEY', 'APPKEY', 'KIS_APP_SECRET', 'KIS_APPSECRET', 'KIS_SECRET', 'APP_SECRET', 'APPSECRET']) {
    childEnv[key] = '';
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
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
  parseInvestorSnapshot,
  parseProgramCurrentRows,
  parseProgramDailyRows,
  sumWindows,
  pbmnToTrillion,
  pbmnToEok,
  INVESTOR_MARKETS,
};
