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

function normalizeRows(rows, date, storeKind = '') {
  const start = storeKind === 'FUTURES' ? '08:45' : '09:00';
  const end = storeKind === 'FUTURES' ? '15:45' : '15:30';
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && String(row.date || '').startsWith(`${date} `))
    .filter((row) => {
      const hhmm = String(row.date || '').slice(11, 16);
      return hhmm >= start && hhmm <= end;
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

  for (const date of dates) {
    const rows = normalizeRows(store.days?.[date]?.[storeKind], date, storeKind);
    const quality = curveQuality(rows);
    // Recency wins over curve length: today's single real/final observation
    // must never lose to a full curve saved on an older session.
    if (rows.length) return { date, rows, quality };
  }
  return null;
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

    // The breakout table now renders market capitalization in index.html.
    // Keep HTML uncached so the updated sortable headers reach users promptly.
    if (req.method === 'GET' && contentType.includes('text/html') && !contentEncoding) {
      const chunks = [];
      innerRes.on('data', (chunk) => chunks.push(chunk));
      innerRes.on('end', () => {
        const html = Buffer.concat(chunks);
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

  // A spot fallback must keep its own source and unit. Never substitute a
  // stored contract curve into a spot response, even when its series is empty.
  if (payload?.source === 'spot-fallback' || (payload?.unit && payload.unit !== config.unit)) {
    return sendJson(res, inner.statusCode, payload);
  }
  if(inner.statusCode!==200||!payload?.ok)return sendJson(res,inner.statusCode,payload);

  const currentRows = Array.isArray(payload?.series) ? payload.series : [];
  // Keep even one real point from the latest trading session. A disk fallback
  // below must belong to that same confirmed session.
  if (currentRows.length) {
    return sendJson(res, inner.statusCode, payload);
  }

  // The gateway establishes the trading date. A missing live response is not
  // proof of a holiday; only reuse a saved curve from that exact session.
  const targetDate=payload.latestOpenDate;
  const stored = /^\d{4}-\d{2}-\d{2}$/.test(targetDate||'')?findLatestStoredCurve(config.storeKind,targetDate):null;
  if (!stored || stored.date!==targetDate) {
    return sendJson(res, inner.statusCode, {
      ...payload,
      note: `${payload?.note || ''} ${targetDate||'최근 개장일'} 수급 자료를 확인하지 못했습니다. 이전 날짜 자료로 바꾸지 않고 재조회합니다.`.trim(),
    });
  }

  const marketLatestOpenDate = payload?.latestOpenDate || stored.date;
  const suffix = '최근 개장일 저장 분봉';

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
  if (apiPath.startsWith('/api/') && !require('./access-control').requireAccess(req,res)) return;

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
