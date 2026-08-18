'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'vkospi.json');
const SYMBOL_ID = '956761';

function normalizeChartPayload(payload) {
  if (!Array.isArray(payload?.t) || !Array.isArray(payload?.c)) return [];
  return payload.t.map((timestamp, index) => ({
    date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
    close: Number(Number(payload.c[index]).toFixed(2))
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0);
}

function normalizeApiPayload(payload) {
  const candidates = Array.isArray(payload) ? payload : (payload?.data || payload?.series || payload?.historicalData || []);
  if (!Array.isArray(candidates)) return [];
  return candidates.map((row) => {
    const rawDate = row?.date || row?.rowDate || row?.rowDateRaw || row?.time || '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate))
      ? String(rawDate)
      : (/^\d{10,13}$/.test(String(rawDate))
        ? new Date(Number(rawDate) * (String(rawDate).length === 10 ? 1000 : 1)).toISOString().slice(0, 10)
        : '');
    const close = Number(String(row?.close ?? row?.last_close ?? row?.lastClose ?? row?.price ?? row?.last ?? '').replace(/,/g, ''));
    return { date, close: Number(close.toFixed(2)) };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0);
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      ...headers
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchSeries() {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 420);
  const from = Math.floor(start.getTime() / 1000);
  const to = Math.floor(now.getTime() / 1000) + 86400;
  const startDate = start.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  const urls = [
    {
      url: `https://tvc6.investing.com/d8f62270e64f9eb6e4e6a07c3ffeab0b/1729428526/9/9/16/history?symbol=${SYMBOL_ID}&resolution=D&from=${from}&to=${to}`,
      normalize: normalizeChartPayload
    },
    {
      url: `https://api.investing.com/api/financialdata/historical/${SYMBOL_ID}?start-date=${startDate}&end-date=${endDate}&interval=P1D&time-frame=Daily`,
      headers: {
        'Domain-Id': 'www',
        Origin: 'https://www.investing.com',
        Referer: 'https://www.investing.com/indices/kospi-volatility-historical-data'
      },
      normalize: normalizeApiPayload
    }
  ];

  const errors = [];
  for (const candidate of urls) {
    try {
      const rows = candidate.normalize(await fetchJson(candidate.url, candidate.headers));
      if (rows.length) {
        const unique = new Map(rows.map((row) => [row.date, row]));
        return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-200);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`VKOSPI sources failed: ${errors.join(' | ')}`);
}

async function main() {
  const series = await fetchSeries();
  const latest = series[series.length - 1];
  if (!latest) throw new Error('VKOSPI series is empty');

  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch { /* First run. */ }
  if (JSON.stringify(previous?.series || []) === JSON.stringify(series)) {
    console.log(`VKOSPI is already current: ${latest.date} ${latest.close}`);
    return;
  }
  const previousLatest = previous?.series?.[previous.series.length - 1]?.date || '';
  if (previousLatest && latest.date < previousLatest) {
    throw new Error(`Refusing stale VKOSPI data: ${latest.date} < ${previousLatest}`);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify({
    source: 'Investing.com KOSPI Volatility (956761)',
    symbol: 'KSVKOSPI',
    updatedAt: new Date().toISOString(),
    series
  }, null, 2)}\n`);
  console.log(`Updated VKOSPI: ${latest.date} ${latest.close} (${series.length} rows)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
