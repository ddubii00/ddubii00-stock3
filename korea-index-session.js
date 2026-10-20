'use strict';

const OFFSET = 9 * 3600;
const LAST_CONTINUOUS = 15 * 60 + 19;
const CLOSE = 15 * 60 + 30;
const CLOSE_READY = CLOSE + 1;
const TTL_MS = 20_000;
const numeric = value => value == null || String(value).trim() === '' ? null :
  Number(String(value).replace(/,/g, ''));
const displayNow = now => Math.floor(Number(now) / 1000) + OFFSET;
const dateAt = time => new Date(time * 1000).toISOString().slice(0, 10);
const minuteAt = time => Math.floor((time % 86400) / 60);

function sessionRows(rows, now = Date.now()) {
  const clock = displayNow(now), today = dateAt(clock);
  return rows.filter(row => {
    const time = Number(row.date);
    if (!Number.isFinite(time) || time > clock) return false;
    const minute = minuteAt(time), date = dateAt(time);
    if (date > today || minute < 9 * 60) return false;
    if (minute <= LAST_CONTINUOUS) return true;
    return minute === CLOSE && (date < today || minuteAt(clock) >= CLOSE_READY);
  });
}

function snapshotTime(row, date) {
  const raw = String(row.localTradedAt || row.dateTime || row.time || row.thistime || '');
  const suppliedDate = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ||
    (/^\d{14}$/.test(raw) ? raw.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '');
  if (suppliedDate && suppliedDate !== date) return null;
  const text = suppliedDate ? raw.slice(raw.includes('-') ? 11 : 8) : raw;
  const match = text.match(/^(\d{2}):?(\d{2})(?::?\d{2})?(?:$|[+.Z-])/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Date.parse(`${date}T${match[1]}:${match[2]}:00Z`) / 1000;
}

function aggregate(rows, step) {
  const groups = new Map();
  for (const row of rows.sort((a, b) => a.date - b.date)) {
    // The 15:30 auction close stays separate even on 60/120-minute charts.
    const time = minuteAt(row.date) === CLOSE ? row.date : Math.floor(row.date / (step * 60)) * step * 60;
    const old = groups.get(time);
    if (!old) groups.set(time, { ...row, date: time });
    else { old.high = Math.max(old.high, row.high); old.low = Math.min(old.low, row.low); old.close = row.close; }
  }
  return [...groups.values()];
}

function createReader({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const cache = new Map(), pending = new Map();
  async function json(url) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://stock.naver.com/' } });
      if (!response.ok) throw new Error('지수 장마감 원천 조회 실패');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  async function load(key, date) {
    const cacheKey = `${key}:${date}`;
    if (cache.get(cacheKey)?.until > now()) return cache.get(cacheKey).rows;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const request = (async () => {
      // Read timestamped observations, never label the first response row with the requested time.
      const pages = await Promise.allSettled([1, 21].map(start => json(`https://stock.naver.com/api/domestic/indexSise/time?koreaIndexType=${key}&thistime=${date.replace(/-/g, '')}&startIdx=${start}&pageSize=20`)));
      const points = new Map();
      for (const page of pages) {
        if (page.status !== 'fulfilled' || !Array.isArray(page.value)) continue;
        for (const row of page.value) {
          const time = snapshotTime(row, date), close = numeric(row.nowVal);
          if (time === null || !(close > 0) || !Number.isFinite(close)) continue;
          // nowVal is a point observation. Day-wide open/high/low are not minute OHLC.
          if (minuteAt(time) >= 15 * 60) points.set(time, { date: time, open: close, high: close, low: close, close });
        }
      }
      const clock = displayNow(now());
      if (date < dateAt(clock) || (date === dateAt(clock) && minuteAt(clock) >= CLOSE_READY)) {
        try {
          const daily = await json(`https://m.stock.naver.com/api/index/${key}/price?pageSize=10&page=1`);
          const row = (Array.isArray(daily) ? daily : []).find(item => String(item.localTradedAt || item.localTradedDate || '').slice(0, 10) === date);
          const close = numeric(row?.closePrice), time = snapshotTime(row || {}, date);
          if (close > 0 && Number.isFinite(close) && (date < dateAt(clock) || (time !== null && time <= clock && minuteAt(time) >= CLOSE))) {
            const stamp = Date.parse(`${date}T15:30:00Z`) / 1000;
            points.set(stamp, { date: stamp, open: close, high: close, low: close, close });
          }
        } catch (_) { /* Keep verified minute observations when the final daily close is unavailable. */ }
      }
      const rows = sessionRows([...points.values()], now());
      cache.set(cacheKey, { rows, until: now() + TTL_MS });
      // Bound this process-local cache without writing any deployment files.
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      return rows;
    })().finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, request);
    return request;
  }
  async function tail(key, date, step = 1) {
    if (!['KOSPI', 'KOSDAQ'].includes(key) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return aggregate(await load(key, date), Math.max(1, Number(step) || 1));
  }
  async function supplement(key, rows, interval) {
    if (!['KOSPI', 'KOSDAQ'].includes(key) || !/^\d+m$/.test(interval) || !rows?.length) return rows;
    const clean = sessionRows(rows, now());
    const dates = rows.map(row => Number(row.date)).filter(Number.isFinite).map(dateAt).sort();
    const date = dates.at(-1);
    const extra = date ? await tail(key, date, parseInt(interval, 10)).catch(() => []) : [];
    const merged = new Map(clean.map(row => [row.date, row]));
    for (const row of extra) {
      const old = merged.get(row.date);
      // For a larger bar preserve its actual earlier open/high/low, updating only its tail.
      merged.set(row.date, old ? { ...old, high: Math.max(old.high, row.high), low: Math.min(old.low, row.low), close: row.close } : row);
    }
    return sessionRows([...merged.values()], now()).sort((a, b) => a.date - b.date);
  }
  return { tail, supplement };
}

module.exports = { sessionRows, snapshotTime, aggregate, createReader };
