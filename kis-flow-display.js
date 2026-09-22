'use strict';

/**
 * stock3 latest-session display wrapper
 *
 * Why this exists
 * - kis-flow-gateway.js already collects KIS investor/futures/program flow.
 * - KIS investor-time API is a current snapshot API, so a full past intraday
 *   curve can only be shown if stock3 actually collected and persisted it.
 * - After the market closes, before the next open, or on holidays/weekends,
 *   this wrapper shows the most recent persisted intraday session instead of
 *   leaving the chart with only a single 15:30 fallback point.
 *
 * Runtime layout
 *   nginx -> this wrapper (PORT, normally 8004)
 *         -> kis-flow-gateway.js (internal port)
 *         -> legacy server.js core
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8000);
const INTERNAL_GATEWAY_PORT = Number(process.env.STOCK3_GATEWAY_INTERNAL_PORT || (PORT + 10001));
const CORE_PORT = Number(process.env.STOCK3_CORE_PORT || (PORT + 10000));
const STORE_PATH = process.env.KIS_FLOW_STORE_PATH || path.join(ROOT, '.runtime', 'kis-flow-gateway.json');
const INTERNAL_HOST = '127.0.0.1';

const KIND_MAP = {
  'kospi-investor-minute': { storeKind: 'KOSPI', unit: '조원', label: 'KOSPI' },
  'kosdaq-investor-minute': { storeKind: 'KOSDAQ', unit: '조원', label: 'KOSDAQ' },
  'foreign-futures-minute': { storeKind: 'FUTURES', unit: '계약', label: 'KOSPI200 선물 외국인' },
};

let child = null;
let shuttingDown = false;
let server = null;

function getKoreaClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: hour * 60 + minute,
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

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { days: {} };
  } catch (_) {
    return { days: {} };
  }
}

function normalizeRows(rows, date) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && String(row.date || '').startsWith(`${date} `))
    .filter((row) => {
      const hhmm = String(row.date || '').slice(11, 16);
      return hhmm >= '09:00' && hhmm <= '15:30';
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function curveQuality(rows) {
  const usable = (rows || []).filter((row) => !row.fallback);
  const count = usable.length;
  if (count >= 30) return 3;
  if (count >= 10) return 2;
  if (count >= 2) return 1;
  return 0;
}

function findLatestStoredCurve(storeKind, notAfterDate) {
  const store = readStore();
  const dates = Object.keys(store.days || {})
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && (!notAfterDate || date <= notAfterDate))
    .sort()
    .reverse();

  let partial = null;
  for (const date of dates) {
    const rows = normalizeRows(store.days?.[date]?.[storeKind], date);
    const quality = curveQuality(rows);
    if (quality >= 2) return { date, rows, quality };
    if (!partial && quality === 1) partial = { date, rows, quality };
  }
  return partial;
}

function isLiveRegularSession(payload) {
  const clock = getKoreaClock();
  const isWeekday = !['Sat', 'Sun'].includes(clock.weekday);
  return isWeekday
    && payload?.latestOpenDate === clock.date
    && clock.minutes >= 9 * 60
    && clock.minutes <= 15 * 60 + 30;
}

function internalRequest(req) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `${INTERNAL_HOST}:${INTERNAL_GATEWAY_PORT}` };
    const proxy = http.request({
      host: INTERNAL_HOST,
      port: INTERNAL_GATEWAY_PORT,
      method: req.method,
      path: req.url,
      headers,
    }, (innerRes) => {
      const chunks = [];
      innerRes.on('data', (chunk) => chunks.push(chunk));
      innerRes.on('end', () => resolve({
        statusCode: innerRes.statusCode || 200,
        headers: innerRes.headers,
        body: Buffer.concat(chunks),
      }));
    });
    proxy.on('error', reject);
    req.pipe(proxy);
  });
}

function proxyToInternal(req, res) {
  const headers = { ...req.headers, host: `${INTERNAL_HOST}:${INTERNAL_GATEWAY_PORT}` };
  const proxy = http.request({
    host: INTERNAL_HOST,
    port: INTERNAL_GATEWAY_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (innerRes) => {
    const contentType = String(innerRes.headers['content-type'] || '');
    const contentEncoding = String(innerRes.headers['content-encoding'] || '');

    // stock3-7 serves the legacy index through the inner core. Inject only one
    // small companion script into HTML so the large index.html does not need to
    // be forked just to add the market-cap column.
    if (req.method === 'GET' && contentType.includes('text/html') && !contentEncoding) {
      const chunks = [];
      innerRes.on('data', (chunk) => chunks.push(chunk));
      innerRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        if (!html.includes('breakout-marketcap.js')) {
          const script = '<script src="breakout-marketcap.js"></script>';
          html = html.includes('</body>') ? html.replace('</body>', `${script}\n</body>`) : `${html}\n${script}`;
        }
        const responseHeaders = { ...innerRes.headers };
        delete responseHeaders['content-length'];
        responseHeaders['cache-control'] = 'no-store';
        res.writeHead(innerRes.statusCode || 200, responseHeaders);
        res.end(html);
      });
      return;
    }

    res.writeHead(innerRes.statusCode || 200, innerRes.headers);
    innerRes.pipe(res);
  });
  proxy.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `stock3 KIS gateway unavailable: ${error.message}` });
    else res.destroy(error);
  });
  req.pipe(proxy);
}

async function handleChartRequest(req, res, config) {
  const inner = await internalRequest(req);
  let payload = null;
  try {
    payload = JSON.parse(inner.body.toString('utf8'));
  } catch (_) {
    res.writeHead(inner.statusCode, inner.headers);
    return res.end(inner.body);
  }

  const currentRows = Array.isArray(payload?.series) ? payload.series : [];
  const live = isLiveRegularSession(payload);

  // During the live session, always show today's KIS data even if only one
  // minute has been collected so far.
  if (live || currentRows.length > 1) {
    return sendJson(res, inner.statusCode, payload);
  }

  // After close / before open / holiday / weekend: prefer the most recent
  // persisted session that has an actual intraday curve.
  const stored = findLatestStoredCurve(config.storeKind, payload?.latestOpenDate || '');
  if (!stored) {
    return sendJson(res, inner.statusCode, {
      ...payload,
      note: `${payload?.note || ''} 분봉 저장 이력이 아직 없어 종가 1점만 표시됩니다. 다음 개장일부터 장중 수집된 최근 개장일 차트를 자동 표시합니다.`.trim(),
    });
  }

  const marketLatestOpenDate = payload?.latestOpenDate || stored.date;
  const suffix = stored.date === marketLatestOpenDate
    ? '최근 개장일 저장 분봉'
    : `분봉 저장된 최근 개장일 ${stored.date}`;

  return sendJson(res, 200, {
    ...payload,
    ok: true,
    unit: config.unit,
    source: `${payload?.source || 'KIS'} · persisted intraday`,
    marketLatestOpenDate,
    latestOpenDate: stored.date,
    displayDate: stored.date,
    note: `${config.label} ${suffix} · 장 종료/휴장 시 마지막으로 저장된 실제 장중 수급 곡선을 표시합니다.`,
    series: stored.rows,
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const apiPath = normalizeApiPath(url.pathname);

  if (apiPath === '/api/extra-chart') {
    const kind = url.searchParams.get('kind') || '';
    const config = KIND_MAP[kind];
    if (config) {
      try {
        return await handleChartRequest(req, res, config);
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: error.message });
      }
    }
  }

  return proxyToInternal(req, res);
}

function spawnGateway() {
  const childEnv = {
    ...process.env,
    PORT: String(INTERNAL_GATEWAY_PORT),
    STOCK3_CORE_PORT: String(CORE_PORT),
  };
  const p = spawn(process.execPath, [path.join(ROOT, 'kis-flow-gateway.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
  });
  p.on('exit', (code, signal) => {
    console.error(`[LATEST SESSION] KIS gateway exited code=${code} signal=${signal || ''}`);
    if (!shuttingDown) process.exit(code || 1);
  });
  return p;
}

function start() {
  child = spawnGateway();
  server = http.createServer((req, res) => void handleRequest(req, res));
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[LATEST SESSION] display wrapper listening on http://127.0.0.1:${PORT}`);
    console.log(`[LATEST SESSION] KIS gateway=${INTERNAL_GATEWAY_PORT}; core=${CORE_PORT}`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[LATEST SESSION] shutting down (${signal})`);
  try { child?.kill('SIGTERM'); } catch (_) {}
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) start();

module.exports = {
  curveQuality,
  findLatestStoredCurve,
  normalizeRows,
};
