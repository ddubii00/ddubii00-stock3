'use strict';

const fs = require('fs');
const path = require('path');
const { fetchVkospiSeries } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'vkospi.json');

function normalizeRows(series) {
  return (Array.isArray(series) ? series : [])
    .map((row) => ({
      date: String(row?.date || ''),
      close: Number(Number(row?.close).toFixed(2))
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-200);
}

async function main() {
  const payload = await fetchVkospiSeries(200);
  if (payload?.unavailable) throw new Error(payload.error || 'VKOSPI series is unavailable');

  const series = normalizeRows(payload?.series);
  const latest = series[series.length - 1];
  if (!latest) throw new Error('VKOSPI series is empty');

  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch { /* First run. */ }

  const previousSeries = normalizeRows(previous?.series);
  const note = String(payload?.note || '');
  if ((note.includes('선물') || note.includes('VKI1')) && previousSeries.length) {
    console.log(`Skipping VKOSPI spot snapshot overwrite; only futures fallback is available: ${latest.date} ${latest.close}`);
    return;
  }

  if (JSON.stringify(previousSeries) === JSON.stringify(series)) {
    console.log(`VKOSPI is already current: ${latest.date} ${latest.close}`);
    return;
  }

  const previousLatest = previousSeries[previousSeries.length - 1]?.date || '';
  if (previousLatest && latest.date < previousLatest) {
    throw new Error(`Refusing stale VKOSPI data: ${latest.date} < ${previousLatest}`);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify({
    source: previous?.source || payload.note || 'VKOSPI',
    symbol: previous?.symbol || 'KSVKOSPI',
    updatedAt: new Date().toISOString(),
    series
  }, null, 2)}\n`);
  console.log(`Updated VKOSPI: ${latest.date} ${latest.close} (${series.length} rows)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
