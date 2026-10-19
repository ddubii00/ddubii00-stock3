(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketRegime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MARKETS = Object.freeze({
    KOSPI: { zone: 'Asia/Seoul', confirmedMinute: 15 * 60 + 40 },
    KOSDAQ: { zone: 'Asia/Seoul', confirmedMinute: 15 * 60 + 40 },
    NASDAQ: { zone: 'America/New_York', confirmedMinute: 16 * 60 + 10 },
    SP500: { zone: 'America/New_York', confirmedMinute: 16 * 60 + 10 }
  });
  function marketConfig(key) {
    return MARKETS[key] || (typeof key === 'string' && /^KR:\d{6}:(KOSPI|KOSDAQ)$/.test(key) ? MARKETS.KOSPI : typeof key === 'string' && /^US:[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?:(NASDAQ|NYSE|AMEX)$/.test(key) ? MARKETS.NASDAQ : null);
  }
  const RULES = Object.freeze({
    ma: [20, 60, 120], warmup: 121, breakout: 60,
    sidewaysSlope: 1, sidewaysRange: 8, recoveryDays: 5, cycleDays: 10,
    stages: [20, 30, 40, 50], stageCash: { 20: 30, 30: 20, 40: 10, 50: 5 }
  });
  const STATES = Object.freeze({
    superBull: { label: '초강세 상승', cash: 0, credit: 30, tone: 'super-bull' },
    strongBull: { label: '강한 상승', cash: 0, credit: 15, tone: 'strong-bull' },
    bull: { label: '일반 상승', cash: 0, credit: 0, tone: 'bull' },
    sideways: { label: '횡보', cash: 10, credit: 0, tone: 'sideways' },
    decline1: { label: '하락 1단계', cash: 20, credit: 0, tone: 'decline1' },
    decline2: { label: '하락 2단계', cash: 40, credit: 0, tone: 'decline2' },
    recovery: { label: '상승추세 회복', cash: 0, credit: 0, tone: 'recovery' },
    pending: { label: '판단보류', cash: null, credit: null, tone: 'pending' }
  });
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const pct = (value, base) => (value / base - 1) * 100;
  const atLeast = (value, boundary) => value + 1e-9 >= boundary;
  const atMost = (value, boundary) => value - 1e-9 <= boundary;

  function normalizeRows(rows) {
    const byDate = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = row?.date ?? row?.time;
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !positive(row.close)) continue;
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) continue;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      byDate.set(date, { date, close: row.close,
        high: positive(row.high) ? Math.max(row.high, row.close) : row.close,
        low: positive(row.low) ? Math.min(row.low, row.close) : row.close,
        confirmed: row.confirmed !== false && row.isFinal !== false });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  function confirmedRows(rows, market, now = new Date()) {
    const config = marketConfig(market);
    if (!config) throw new Error('지원하지 않는 지수');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: config.zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    // No exchange calendar is inferred. Use published bars only, exclude an open
    // session, and conservatively allow 10 minutes for the regular close to settle.
    // Early closes are also accepted only after the normal-session cutoff.
    return normalizeRows(rows).filter((row) => row.confirmed &&
      (row.date < today || (row.date === today && minutes >= config.confirmedMinute)));
  }

  function mergeHistory(stored, incoming) {
    return normalizeRows([...(Array.isArray(stored) ? stored : []), ...(Array.isArray(incoming) ? incoming : [])]);
  }

  function averages(rows, period) {
    let sum = 0;
    return rows.map((row, i) => {
      sum += row.close;
      if (i >= period) sum -= rows[i - period].close;
      return i >= period - 1 ? sum / period : null;
    });
  }

  function inspect(rows, ma, i, below20, above20, above120) {
    const close = rows[i].close;
    const rising = (period, lag = 1) => i >= lag && ma[period][i - lag] !== null && ma[period][i] > ma[period][i - lag] + 1e-9;
    const slope20 = ma[20][i - 5] ? pct(ma[20][i], ma[20][i - 5]) : null;
    const recent = rows.slice(Math.max(0, i - 19), i + 1);
    const range20 = recent.length === 20 ? pct(Math.max(...recent.map((r) => r.high)), Math.min(...recent.map((r) => r.low))) : null;
    const prior60 = rows.slice(Math.max(0, i - RULES.breakout), i);
    return { close, ma20: ma[20][i], ma60: ma[60][i], ma120: ma[120][i],
      rising20: rising(20), rising60: rising(60), rising120: rising(120), rising60Ten: rising(60, 10),
      ordered: ma[20][i] > ma[60][i] && ma[60][i] > ma[120][i],
      breakout: prior60.length === RULES.breakout && close > Math.max(...prior60.map((r) => r.close)),
      below20, above20, above120, slope20, range20 };
  }

  function stageState(stage) {
    return { label: `고점 대비 -${stage}%`, cash: RULES.stageCash[stage], credit: 0, tone: 'oversold' };
  }

  function conditionRows(metrics, cycle, drawdown, cycleReset, recovery, newStages) {
    const c = (label, met) => ({ label, met: met == null ? null : Boolean(met) });
    const trend = [c('20일선 > 60일선 > 120일선', metrics.ordered),
      c('20·60·120일선 모두 전일 대비 상승', metrics.rising20 && metrics.rising60 && metrics.rising120)];
    return [
      { key: 'newCycle', label: '새 상승 사이클', met: cycleReset, conditions: [c('하락 사이클 시작 후 120일선 위 10거래일 연속', cycle.above120 >= 10 || cycleReset), c('60일선이 10거래일 전보다 상승', metrics.rising60Ten)] },
      { key: 'recovery', label: '상승추세 회복', met: recovery, conditions: [c('하락 사이클 진행 중', cycle.declining || cycleReset), c('20일선 위 5거래일 연속', metrics.above20 >= 5), c('20일선 전일 대비 상승', metrics.rising20)] },
      ...RULES.stages.slice().reverse().map((value) => ({ key: `drawdown${value}`, label: `고점 대비 -${value}%`, met: atLeast(-drawdown, value), conditions: [c(`기준 최고 종가 대비 ${value}% 이상 하락`, atLeast(-drawdown, value)), c('같은 사이클에서 처음 도달', newStages.includes(value))] })),
      { key: 'decline2', label: '하락 2단계', met: atMost(drawdown, -10) && metrics.close < metrics.ma20 && (metrics.below20 >= 3 || metrics.slope20 < 0), conditions: [c('고점 대비 -10% 이상', atMost(drawdown, -10)), c('종가가 20일선 아래', metrics.close < metrics.ma20), c('3일 연속 하회 또는 20일선 5일 변화율 음수', metrics.below20 >= 3 || metrics.slope20 < 0)] },
      { key: 'decline1', label: '하락 1단계', met: metrics.below20 >= 2, conditions: [c('20일선 아래 2거래일 연속 종가', metrics.below20 >= 2)] },
      { key: 'superBull', label: '초강세 상승', met: metrics.ordered && metrics.rising20 && metrics.rising60 && metrics.rising120 && metrics.breakout, conditions: [...trend, c('직전 60거래일 최고 종가 초과', metrics.breakout)] },
      { key: 'strongBull', label: '강한 상승', met: metrics.ordered && metrics.rising20 && metrics.rising60 && metrics.rising120 && !metrics.breakout, conditions: [...trend, c('초강세 돌파 조건 미충족', !metrics.breakout)] },
      { key: 'bull', label: '일반 상승', met: metrics.close > metrics.ma20 && metrics.rising20, conditions: [c('종가가 20일선 위', metrics.close > metrics.ma20), c('20일선 전일 대비 상승', metrics.rising20)] },
      { key: 'sideways', label: '횡보', met: atMost(Math.abs(metrics.slope20), 1) && atMost(metrics.range20, 8), conditions: [c('20일선 5일 변화율 ±1% 이내', atMost(Math.abs(metrics.slope20), 1)), c('최근 20일 고저 범위 / 최저가 ≤ 8%', atMost(metrics.range20, 8))] }
    ];
  }

  function analyze(input, market, options = {}) {
    const rows = confirmedRows(input, market, options.now ?? new Date());
    const ma = Object.fromEntries(RULES.ma.map((period) => [period, averages(rows, period)]));
    let result = null, previousKey = null, transitionDate = null;
    let below20 = 0, above20 = 0, above120 = 0;
    let cycle = { id: rows[0]?.date || null, peak: null, peakDate: null, declining: false, declineStart: null, above120: 0, stages: [] };
    const transitions = [], stageSignals = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!cycle.declining && (cycle.peak === null || row.close > cycle.peak)) { cycle.peak = row.close; cycle.peakDate = row.date; }
      below20 = ma[20][i] !== null && row.close < ma[20][i] ? below20 + 1 : 0;
      above20 = ma[20][i] !== null && row.close > ma[20][i] ? above20 + 1 : 0;
      above120 = ma[120][i] !== null && row.close > ma[120][i] ? above120 + 1 : 0;
      if (i + 1 < RULES.warmup) continue;
      const metrics = inspect(rows, ma, i, below20, above20, above120);
      let drawdown = pct(row.close, cycle.peak);
      const decline2 = atMost(drawdown, -10) && row.close < metrics.ma20 && (below20 >= 3 || metrics.slope20 < 0);
      if (!cycle.declining && (below20 >= 2 || decline2 || atMost(drawdown, -20))) {
        cycle.declining = true; cycle.declineStart = row.date; cycle.above120 = 0;
      }
      if (cycle.declining) cycle.above120 = row.close > metrics.ma120 ? cycle.above120 + 1 : 0;
      const cycleReset = cycle.declining && cycle.above120 >= RULES.cycleDays && metrics.rising60Ten;
      if (cycleReset) {
        const peakRow = rows.slice(i - RULES.cycleDays + 1, i + 1).reduce((a, b) => b.close > a.close ? b : a);
        cycle = { id: row.date, peak: peakRow.close, peakDate: peakRow.date, declining: false, declineStart: null, above120: 0, stages: [] };
        drawdown = pct(row.close, cycle.peak);
      }
      const newStages = cycle.declining ? RULES.stages.filter((stage) => atMost(drawdown, -stage) && !cycle.stages.some((s) => s.stage === stage)) : [];
      for (const stage of newStages) {
        const signal = { id: `${market}:${cycle.id}:${stage}`, stage, date: row.date, cycleId: cycle.id, targetCash: RULES.stageCash[stage], execution: '다음 거래일', kind: '판단 신호' };
        cycle.stages.push(signal); stageSignals.push(signal);
      }
      const deepest = cycle.stages.at(-1)?.stage || 0;
      const recovery = (cycle.declining || cycleReset) && above20 >= RULES.recoveryDays && metrics.rising20;
      const conditions = conditionRows(metrics, cycle, drawdown, cycleReset, recovery, newStages);
      const met = (key) => conditions.find((item) => item.key === key).met;
      // Precedence: qualified cycle reset (housekeeping), short recovery, retained
      // drawdown stage, decline 2, decline 1, strongest-to-weakest rise, sideways.
      // Recovery changes the target, never clears stage signals in the same cycle.
      let key = recovery ? 'recovery' : deepest ? `drawdown${deepest}` :
        ['decline2', 'decline1', 'superBull', 'strongBull', 'bull', 'sideways'].find(met);
      const carried = !key && previousKey !== null && !cycleReset;
      key = key || (cycleReset ? 'pending' : previousKey) || 'pending';
      const state = key.startsWith('drawdown') ? stageState(Number(key.slice(8))) : STATES[key];
      if (key !== previousKey) {
        transitionDate = row.date;
        transitions.push({ date: row.date, from: previousKey, to: key });
      }
      previousKey = key;
      result = { market, key, ...state, exposure: state.cash === null ? null : 100 - state.cash + state.credit,
        asOf: row.date, transitionDate, close: row.close, drawdown, cycle: { ...cycle, stages: cycle.stages.slice() },
        metrics, conditions, carried, cycleReset, recovery, newStages,
        allocationKind: '목표 비중', execution: '신호 확정 후 다음 거래일', stageSignals: stageSignals.slice(), transitions: transitions.slice(),
        historyStart: rows[0].date, historyCount: rows.length };
    }
    if (!result) return { market, key: 'pending', ...STATES.pending, exposure: null, asOf: rows.at(-1)?.date || null, transitionDate: null,
      close: rows.at(-1)?.close || null, drawdown: null, cycle: null, metrics: null, conditions: [], carried: false,
      stageSignals: [], transitions: [], historyStart: rows[0]?.date || null, historyCount: rows.length,
      reason: `확정 일봉 ${RULES.warmup}개 이상 필요 (현재 ${rows.length}개)` };
    return result;
  }

  return { VERSION, MARKETS, RULES, STATES, marketConfig, normalizeRows, confirmedRows, mergeHistory, averages, analyze };
});
