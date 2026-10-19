'use strict';

const WINDOWS = [1, 3, 5, 10, 20];
function numericOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumWindows(rows, windows = WINDOWS, scale = 1, truncate = false) {
  const ordered = (Array.isArray(rows) ? rows : []).filter((row) => row?.date)
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return windows.map((days) => {
    const sample = ordered.slice(-days);
    if (sample.length < days || sample.some((row) => numericOrNull(row.value) === null)) return null;
    const sum = sample.reduce((total, row) => total + numericOrNull(row.value), 0) * scale;
    if (!truncate) return Math.round(sum);
    // Correct only binary floating-point noise at an integer boundary (e.g.
    // 0.35 * 3 * 10000). Genuine fractional eok amounts are still truncated.
    const integer = Math.round(sum);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(sum)) * sample.length * 2;
    return Math.trunc(Math.abs(sum - integer) <= tolerance ? integer : sum);
  });
}

function nullableArray(values) {
  if (!Array.isArray(values)) return null;
  const result = WINDOWS.map((_, index) => numericOrNull(values[index]));
  return result.some((value) => value !== null) ? result : null;
}

function programNetEok(row) {
  const num=value=>numericOrNull(typeof value==='string'?value.replace(/,/g,''):value);
  const direct=num(row?.whol_smtn_ntby_tr_pbmn);
  if(direct!==null)return direct/100;
  // The official DAILY schema may omit whole net money. Use whole buy minus
  // whole sell, or arbitrage + non-arbitrage totals; both operands are required.
  const buy=num(row?.whol_smtn_shnu_tr_pbmn),sell=num(row?.whol_smtn_seln_tr_pbmn);
  if(buy!==null&&sell!==null)return (buy-sell)/100;
  const arb=num(row?.arbt_smtn_ntby_tr_pbmn),nonarb=num(row?.nabt_smtn_ntby_tr_pbmn);
  return arb!==null&&nonarb!==null?(arb+nonarb)/100:null;
}

function futuresStats(payload) {
  const spot = payload?.source === 'spot-fallback';
  const contracts = payload?.unit === '계약' && !spot;
  const rows = (spot || contracts) && Array.isArray(payload?.series)
    ? payload.series.map((row) => ({ date: row.date, value: numericOrNull(row.dailyForeign) })) : [];
  return {
    futuresMode: spot ? 'spot-fallback' : 'futures',
    futuresUnit: spot ? '억원' : '계약',
    // Spot history is in trillion KRW. Truncate *after* summing and converting.
    futuresArray: nullableArray(sumWindows(rows, WINDOWS, spot ? 10000 : 1, spot)),
  };
}

function mergeWindowValues(primary, coverageDays, fallback) {
  return WINDOWS.map((window, index) => {
    const value = numericOrNull(primary?.[index]);
    if (coverageDays >= window && value !== null) return value;
    return numericOrNull(fallback?.[index]) ?? value;
  });
}

function mergeFlowStats(core = {}, flow = null) {
  const spot = core.futuresMode === 'spot-fallback';
  // Choose one unit for the entire row; never fill spot windows with contracts.
  const futures = spot ? nullableArray(core.futuresArray) : nullableArray(mergeWindowValues(
    flow?.futuresArray, flow?.futuresCoverageDays || 0,
    core.futuresUnit === '계약' ? core.futuresArray : null
  ));
  const flowPrograms = flow?.programSource && flow.programSource !== 'unavailable' ? flow.progsArray : null;
  const corePrograms = core.programSource && core.programSource !== 'unavailable' ? core.progsArray : null;
  const programs = nullableArray(mergeWindowValues(flowPrograms, flow?.programCoverageDays || 0, corePrograms));
  const primaryProgram = nullableArray(flowPrograms) !== null;
  return {
    ...core,
    futuresMode: spot ? 'spot-fallback' : 'futures',
    futuresUnit: spot ? '억원' : '계약',
    futuresArray: futures,
    progsArray: programs,
    futuresLatest: flow?.futuresLatest || core.futuresLatest || null,
    programAsOfDate: primaryProgram ? flow.programAsOfDate || flow.latestOpenDate : core.programAsOfDate || '',
    programError: programs ? '' : core.programError || '프로그램 원천 응답을 확인하세요.',
    programSource: primaryProgram ? flow.programSource : core.programSource || 'unavailable',
    futuresCoverageDays: spot ? core.futuresCoverageDays || 0 : flow?.futuresCoverageDays || 0,
    programCoverageDays: primaryProgram ? flow?.programCoverageDays || 0 : core.programCoverageDays || 0,
  };
}

module.exports = { WINDOWS, numericOrNull, sumWindows, nullableArray, programNetEok, futuresStats, mergeWindowValues, mergeFlowStats };
