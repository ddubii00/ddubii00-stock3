'use strict';

// Initial calibration values: keep all weights, anchors and windows here.
const WEIGHTS = Object.freeze({ volatility: 0.25, ratesFx: 0.15, flow: 0.20, breadth: 0.10, trend: 0.15, sox: 0.10, liquidity: 0.05 });
const STATE_CUTS = Object.freeze({ friendly: 65, neutral: 45, caution: 30 });
const CONFIG = Object.freeze({
  shortWindow: 5, ma20: 20, ma60: 60, flowLookback: 60, vkospiMinObservations: 60,
  coverageMinimum: 0.6, flowZScale: 2, breadthSmoothing: 10,
  vixAnchors: [[13, 1], [16, 0.5], [20, 0], [25, -0.5], [30, -1]],
  yieldAnchors: [[-20, 0.5], [0, 0], [20, -1]],
  fxAnchors: [[-1, 0.5], [0, 0], [2, -1]],
  ma20GapAnchors: [[-5, -1], [5, 1]], ma60GapAnchors: [[-10, -1], [10, 1]],
  return20Anchors: [[-10, -1], [10, 1]], soxAnchors: [[-3, -1], [3, 1]],
  liquidityRatioScale: 0.3, liquidityDirectionScale: 2,
  foreignDisplayDivisor: 1e12, turnoverDisplayDivisor: 1e6,
});
const NAMES = Object.freeze({ volatility: '변동성', ratesFx: '금리·환율', flow: '외국인 수급', breadth: '52주 시장폭', trend: 'KOSPI 추세', sox: 'SOX', liquidity: '유동성' });

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));

function interpolate(value, anchors) {
  if (!finite(value)) return null;
  if (value <= anchors[0][0]) return clamp(anchors[0][1]);
  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (value <= x2) return clamp(y1 + (y2 - y1) * (value - x1) / (x2 - x1));
  }
  return clamp(anchors.at(-1)[1]);
}

function mean(values) {
  const available = values.filter(finite);
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

function meanLast(values, window) {
  const sample = values.slice(-window);
  return sample.length === window && sample.every(finite) ? mean(sample) : null;
}

function returnOver(values, window) {
  if (values.length <= window) return null;
  const current = values.at(-1);
  const previous = values.at(-window - 1);
  return finite(current) && finite(previous) && previous > 0 ? (current / previous - 1) * 100 : null;
}

function yieldChangeBp(values) {
  if (values.length <= CONFIG.shortWindow) return null;
  const current = values.at(-1);
  const previous = values.at(-CONFIG.shortWindow - 1);
  return finite(current) && finite(previous) ? (current - previous) * 100 : null;
}

function percentile(value, observations) {
  const sorted = observations.filter(finite).sort((a, b) => a - b);
  if (!finite(value) || sorted.length < CONFIG.vkospiMinObservations) return null;
  if (sorted[0] === sorted.at(-1)) return 0.5;
  const firstEqual = sorted.indexOf(value);
  if (firstEqual >= 0) return (firstEqual + sorted.lastIndexOf(value)) / (2 * (sorted.length - 1));
  if (value < sorted[0]) return 0;
  if (value > sorted.at(-1)) return 1;
  const upper = sorted.findIndex((item) => item > value);
  return ((upper - 1) + (value - sorted[upper - 1]) / (sorted[upper] - sorted[upper - 1])) / (sorted.length - 1);
}

function normalizeVix(values) { return interpolate(meanLast(values, CONFIG.shortWindow), CONFIG.vixAnchors); }
function normalizeVkospi(values) {
  const rank = percentile(meanLast(values, CONFIG.shortWindow), values);
  return rank === null ? null : clamp(1 - 2 * rank);
}
function normalizeVolatility(vix, vkospi) { return mean([normalizeVix(vix), normalizeVkospi(vkospi)]); }
function normalizeRatesFx(yields, fx) {
  return mean([interpolate(yieldChangeBp(yields), CONFIG.yieldAnchors), interpolate(returnOver(fx, CONFIG.shortWindow), CONFIG.fxAnchors)]);
}

function flowDistribution(values) {
  const sums = [];
  for (let end = CONFIG.shortWindow; end <= values.length; end += 1) {
    const sample = values.slice(end - CONFIG.shortWindow, end);
    sums.push(sample.every(finite) ? sample.reduce((sum, value) => sum + value, 0) : null);
  }
  return sums.slice(-CONFIG.flowLookback);
}

function normalizeFlow(values) {
  const distribution = flowDistribution(values);
  if (distribution.length < CONFIG.flowLookback || !distribution.every(finite)) return null;
  if (distribution.every((value) => value === distribution[0])) return 0;
  const average = mean(distribution);
  const deviation = Math.sqrt(mean(distribution.map((value) => (value - average) ** 2)));
  // Constant flows provide no relative surprise; a genuine zero is neutral.
  return deviation === 0 ? 0 : clamp((distribution.at(-1) - average) / deviation / CONFIG.flowZScale);
}

function normalizeBreadth(high, low) {
  if (!finite(high) || !finite(low) || high < 0 || low < 0) return null;
  return clamp((high - low) / (high + low + CONFIG.breadthSmoothing));
}

function normalizeTrend(closes) {
  const current = closes.at(-1);
  const ma20 = meanLast(closes, CONFIG.ma20);
  const ma60 = meanLast(closes, CONFIG.ma60);
  const ret20 = returnOver(closes, CONFIG.ma20);
  if (!finite(current) || !(ma20 > 0) || !(ma60 > 0) || ret20 === null) return null;
  return mean([
    interpolate((current / ma20 - 1) * 100, CONFIG.ma20GapAnchors),
    interpolate((current / ma60 - 1) * 100, CONFIG.ma60GapAnchors),
    interpolate(ret20, CONFIG.return20Anchors),
  ]);
}

function normalizeSox(closes) { return interpolate(returnOver(closes, CONFIG.shortWindow), CONFIG.soxAnchors); }
function normalizeLiquidity(turnovers, closes) {
  const avg5 = meanLast(turnovers, CONFIG.shortWindow);
  const avg20 = meanLast(turnovers, CONFIG.ma20);
  const ret5 = returnOver(closes, CONFIG.shortWindow);
  if (avg5 === null || !(avg20 > 0) || ret5 === null || turnovers.slice(-CONFIG.ma20).some((value) => value < 0)) return null;
  // Assumption: unusually high turnover reinforces the 5-day price direction;
  // unusually low turnover reverses that sign. This is a proxy, not causal evidence.
  return clamp((avg5 / avg20 - 1) / CONFIG.liquidityRatioScale) * clamp(ret5 / CONFIG.liquidityDirectionScale);
}

function combine(input = {}) {
  const values = Array.isArray(input) ? Object.fromEntries(input.map((item) => [item.key, item.normalized === undefined ? item.point : item.normalized])) : input;
  const keys = Object.keys(WEIGHTS);
  const missing = keys.filter((key) => !finite(values[key]));
  const covered = keys.filter((key) => finite(values[key]));
  const weightCovered = Number(covered.reduce((sum, key) => sum + WEIGHTS[key], 0).toFixed(10));
  const degraded = weightCovered < CONFIG.coverageMinimum;
  const average = weightCovered ? covered.reduce((sum, key) => sum + clamp(values[key]) * WEIGHTS[key], 0) / weightCovered : null;
  const score = average === null ? null : clamp(Math.round(50 + 50 * average), 0, 100);
  const state = degraded ? '데이터부족' : score >= STATE_CUTS.friendly ? '우호' : score >= STATE_CUTS.neutral ? '중립' : score >= STATE_CUTS.caution ? '경계' : '위험';
  return { score, state, coverage: { available: covered.length, total: keys.length, weightCovered, missing }, degraded };
}

function method() {
  return `각 지표를 -1~+1로 연속 정규화한 가중평균을 0~100점으로 환산합니다. 결측 항목은 제외하고 가중치를 재정규화합니다. ${Object.entries(WEIGHTS).map(([key, weight]) => `${NAMES[key]} ${Math.round(weight * 100)}%`).join(', ')}. 반영 가중치 ${Math.round(CONFIG.coverageMinimum * 100)}% 미만은 데이터부족입니다.`;
}

function buildRiskScore({ vixRows = [], soxRows = [], usdkrwRows = [], us10yRows = [], us2yRows = [], kospiRows = [], breadth = null, vkospi = null } = {}) {
  const closes = (rows) => rows.map((row) => finite(row.close) ? row.close : null);
  const dateOf = (rows) => rows.at(-1)?.date || rows.at(-1)?.asOf || '';
  const vkospiRows = (Array.isArray(vkospi?.series) ? vkospi.series : []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const vix = closes(vixRows), vk = closes(vkospiRows), sox = closes(soxRows);
  const fx = closes(usdkrwRows), yields = closes(us10yRows), kospi = closes(kospiRows);
  const turnovers = kospiRows.map((row) => row.turnover);
  const foreign = kospiRows.map((row) => row.foreign);
  const vixUsed = normalizeVix(vix) !== null, vkUsed = normalizeVkospi(vk) !== null;
  const vkLabel = /futures|VKI1/i.test(`${vkospi?.source || ''} ${vkospi?.symbol || ''}`) ? 'VKOSPI 선물' : 'VKOSPI';
  const volInputs = [vixUsed ? 'VIX' : '', vkUsed ? vkLabel : ''].filter(Boolean);
  const volDisplay = [vixUsed ? `VIX 5일평균 ${meanLast(vix, CONFIG.shortWindow).toFixed(2)}` : '', vkUsed ? `${vkLabel} 5일평균 ${meanLast(vk, CONFIG.shortWindow).toFixed(2)}` : ''].filter(Boolean).join(' / ');
  const us10 = us10yRows.at(-1)?.close, us2 = us2yRows.at(-1)?.close;
  const spread = finite(us10) && finite(us2) ? us10 - us2 : null;
  const flowMean = meanLast(foreign, CONFIG.shortWindow);
  const avg5 = meanLast(turnovers, CONFIG.shortWindow), avg20 = meanLast(turnovers, CONFIG.ma20);
  const ratio = avg5 !== null && avg20 > 0 ? avg5 / avg20 : null;
  const high = breadth?.highCount, low = breadth?.lowCount;
  const last = kospiRows.at(-1) || {};
  const components = [
    { key: 'volatility', name: `변동성${volInputs.length ? ` ${volInputs.join('/')}` : ''}`, normalized: normalizeVolatility(vix, vk), value: vixUsed ? vix.at(-1) : vkUsed ? vk.at(-1) : null, displayValue: volDisplay || '원천 확인 중', unit: '지수', changeRate: vixUsed ? returnOver(vix, 1) : null, asOf: [vixUsed ? dateOf(vixRows) : '', vkUsed ? dateOf(vkospiRows) : ''].filter(Boolean).sort().at(-1) || '', reason: `VIX 5일평균의 연속 앵커와 ${vkLabel} 5일평균의 전체 시계열 백분위를 반영합니다. VKOSPI는 관측 60개 이상일 때만 사용하며, 사용 가능한 입력만 평균합니다.${vkUsed ? ` ${vkLabel} 기준일 ${dateOf(vkospiRows)} (${vkospi?.source || '저장 자료'}).` : ''}` },
    { key: 'ratesFx', name: '금리·환율', normalized: normalizeRatesFx(yields, fx), value: spread, unit: '10Y-2Y %p(참고)', changeRate: returnOver(fx, CONFIG.shortWindow), asOf: dateOf(usdkrwRows) || dateOf(us10yRows), reason: `US10Y 5일 변화 ${yieldChangeBp(yields)?.toFixed(2) ?? '-'}bp와 원/달러 5일 누적 변화율을 연속 정규화해 평균합니다. 스프레드는 표시 전용입니다.` },
    { key: 'flow', name: '외국인 현물 수급', normalized: normalizeFlow(foreign), value: flowMean === null ? null : flowMean * CONFIG.shortWindow / CONFIG.foreignDisplayDivisor, unit: '조원', changeRate: null, asOf: dateOf(kospiRows), reason: '선물 공개 원천 대체인 KOSPI 외국인 현물 순매수 5일 누적을 최근 60거래일의 5일 누적 분포에 대한 z-score/2로 정규화합니다.' },
    { key: 'breadth', name: '시장폭 52주 신고가·신저가', normalized: normalizeBreadth(high, low), value: finite(high) && finite(low) ? high - low : null, displayValue: finite(high) && finite(low) ? `52주 신고가 ${high}개 / 52주 신저가 ${low}개` : '원천 확인 중', unit: '개', changeRate: null, asOf: breadth?.latestTradeDate || '', reason: '최근 거래일의 고가가 최근 52주(약 1년) 최고가 이상인 종목과 저가가 최근 52주 최저가 이하인 종목을 집계합니다. 시장폭 점수는 (신고가-신저가)/(신고가+신저가+10)으로 계산하며, 20일 개수는 별도 집계합니다.' },
    { key: 'trend', name: 'KOSPI 추세', normalized: normalizeTrend(kospi), value: last.close ?? null, unit: '지수', changeRate: returnOver(kospi, CONFIG.ma20), asOf: dateOf(kospiRows), reason: 'KOSPI 종가의 MA20·MA60 대비 위치와 20일 누적 수익률을 각각 연속 정규화해 평균합니다.' },
    { key: 'sox', name: '섹터모멘텀 SOX', normalized: normalizeSox(sox), value: sox.at(-1) ?? null, unit: '지수', changeRate: returnOver(sox, CONFIG.shortWindow), asOf: dateOf(soxRows), reason: 'SOX 5거래일 누적 변화율을 -3%→-1, +3%→+1 앵커로 연속 정규화합니다.' },
    { key: 'liquidity', name: '유동성 거래대금', normalized: normalizeLiquidity(turnovers, kospi), value: last.turnover == null ? null : last.turnover / CONFIG.turnoverDisplayDivisor, unit: '조원', changeRate: returnOver(kospi, CONFIG.shortWindow), asOf: dateOf(kospiRows), reason: `거래대금 5일평균/20일평균 비율 ${ratio?.toFixed(2) ?? '-'}의 강도에 KOSPI 5일 수익률 방향을 곱합니다. 거래대금 증가가 가격 방향을 강화한다는 가정입니다.` },
  ];
  return {
    ...combine(components),
    components: components.map((item) => {
      const available = item.normalized !== null;
      const weight = WEIGHTS[item.key];
      return { ...item, weight, point: available ? Number(item.normalized.toFixed(2)) : null, contribution: available ? item.normalized * weight * 50 : null, available };
    }),
    method: method(),
  };
}

module.exports = { WEIGHTS, STATE_CUTS, CONFIG, NAMES, clamp, interpolate, meanLast, returnOver, yieldChangeBp, normalizeVix, normalizeVkospi, normalizeVolatility, normalizeRatesFx, normalizeFlow, normalizeBreadth, normalizeTrend, normalizeSox, normalizeLiquidity, combine, method, buildRiskScore };
