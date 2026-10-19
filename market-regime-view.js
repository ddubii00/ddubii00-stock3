(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./market-regime'));
  else root.MarketRegimeView = factory(root.MarketRegime, root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (engine, browser) {
  'use strict';
  const MA_COLORS = { 20: '#0a9d58', 60: '#111827', 120: '#ed6f35' };
  const pendingRequests = new Map();
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '-';
  const indexValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) : '-';
  const percent = (value) => value === null || value === undefined ? '-' : `${number(value)}%`;
  const direction = (value, prior) => prior == null ? { arrow: '→', tone: 'flat', text: '확인 중' } :
    value > prior + 1e-9 ? { arrow: '↗', tone: 'up', text: '상승' } : value < prior - 1e-9 ? { arrow: '↘', tone: 'down', text: '하락' } : { arrow: '→', tone: 'flat', text: '보합' };

  function render(result, options = {}) {
    const rows = options.rows || [];
    const latest = rows.at(-1);
    const positions = latest ? [{ label: '현재가', value: latest.close, arrow: '›', tone: 'flat', text: '확정 종가', color: '#172033' },
      ...engine.RULES.ma.map((period) => {
        const values = engine.averages(rows, period);
        const value = values.at(-1), prior = values.at(-2);
        return { label: `${period}일`, value, ...direction(value, prior), color: MA_COLORS[period] };
      })].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity)) : [];
    const stack = positions.length ? positions.map((item) => `<div class="regime-position-row"><span style="color:${item.color}">${item.label}</span><span class="regime-arrow ${item.tone}" aria-label="${item.text}" title="${item.text}">${item.arrow}</span><strong style="color:${item.color}">${indexValue(item.value)}</strong></div>`).join('') : '<span>이평 위치 확인 중</span>';
    return `<div class="index-regime-layout">
      <div class="regime-positions">${stack}</div>
      <div class="regime-overview">
        <strong class="regime-state ${escape(result.tone)}">${escape(result.label)}</strong>
        <div class="regime-allocations" title="목표 비중이며 실제 계좌 비중과 다를 수 있습니다. 주식 노출률 = 100 − 현금 + 신용(순자산 대비)"><span>목표 현금 <b>${percent(result.cash)}</b></span><span>목표 신용 <b>${percent(result.credit)}</b></span><span>주식 노출률 <b>${percent(result.exposure)}</b></span></div>
        <div class="regime-targets" title="기준 최고 종가 ${escape(result.cycle?.peakDate || '-')}">기준 고점 <b>${indexValue(result.cycle?.peak)}</b> · 낙폭 <b>${percent(result.drawdown == null ? null : Math.min(0, result.drawdown))}</b></div>
        <div class="regime-confirmed-date" title="신호 기준 ${escape(result.asOf || '-')} · 최근 국면 전환 ${escape(result.transitionDate || '-')} · 다음 거래일 실행 기준">기준 ${escape(result.asOf?.slice(5) || '-')} · 전환 ${escape(result.transitionDate?.slice(5) || '-')}</div>
      </div>
    </div>
    ${options.error ? `<div class="regime-notice">${escape(options.error)}</div>` : ''}
    ${result.reason ? `<div class="regime-notice">${escape(result.reason)}</div>` : ''}
    `;

  }

  function evaluate(rows, market, storage, now = new Date()) {
    const key = `stock3-market-regime-v${engine.VERSION}:${market}`;
    let stored = [], persistent = true;
    try {
      const saved = storage?.getItem(key);
      if (saved) stored = JSON.parse(saved);
      if (!Array.isArray(stored)) { stored = []; persistent = false; }
      if (!storage) persistent = false;
    } catch (_) { persistent = false; }
    const incoming = engine.confirmedRows(rows, market, now);
    // Never turn a failed/empty response into a fresh allocation using saved data.
    if (!incoming.length) throw new Error('확정 일봉 원천 데이터가 없습니다.');
    const merged = engine.mergeHistory(stored, incoming);
    const confirmed = engine.confirmedRows(merged, market, now);
    const result = engine.analyze(confirmed, market, { now });
    try {
      if (storage) storage.setItem(key, JSON.stringify(confirmed));
    } catch (_) { persistent = false; }
    return { result, rows: confirmed, persistent };
  }

  async function update(inst, rows, urlFor = (path) => path) {
    const market = inst.options?.apiKey || inst.key;
    if (!engine.marketConfig(market) || !inst.options?.maCompare) return;
    const panelKey = inst.options?.regimePanelKey || market;
    const requestKey = `${panelKey}:${market}`;
    const node = browser.document.getElementById(`market-regime-${panelKey}`);
    if (!node) return;
    const fail = (error) => {
      const pending = engine.analyze([], market);
      node.innerHTML = render(pending, { error: `${error.message || '원천 조회 실패'} · 목표 비중 판단 보류` });
    };
    const apply = (input) => {
      let storage;
      try { storage = browser.localStorage; } catch (_) { /* blocked storage is optional */ }
      const state = evaluate(input, market, storage);
      node.innerHTML = render(state.result, state);
      if (!state.persistent && !inst.regimeStorageWarning) {
        browser.console?.warn('시장 국면 이력을 브라우저에 저장하지 못했습니다. 조회 이력으로만 계산합니다.');
        inst.regimeStorageWarning = true;
      }
      inst.regimeUpdatedAt = Date.now();
    };
    let requestRevision = null;
    try {
      if (Array.isArray(rows)) { inst.regimeRevision = (inst.regimeRevision || 0) + 1; apply(rows); return; }
      // The owner handles the error with its revision guard. Other consumers
      // share the request without leaking a rejected promise or clearing newer UI.
      if (pendingRequests.has(requestKey)) return pendingRequests.get(requestKey).catch(() => {});
      if (inst.regimeUpdatedAt && Date.now() - inst.regimeUpdatedAt < 60_000) return;
      const revision = inst.regimeRevision || 0;
      requestRevision = revision;
      const request = (async () => {
        const response = await browser.fetch(urlFor(`/api/chart?key=${encodeURIComponent(market)}&interval=1d`), { cache: 'no-store' });
        const json = await response.json();
        if (!response.ok || !json.ok || !Array.isArray(json.series) || !json.series.length) throw new Error('확정 일봉 조회 실패');
        if ((inst.regimeRevision || 0) === revision && (inst.options?.apiKey || inst.key) === market) apply(json.series);
      })();
      pendingRequests.set(requestKey, request);
      try { await request; } finally { pendingRequests.delete(requestKey); }
    } catch (error) {
      if ((inst.options?.apiKey || inst.key) === market && (requestRevision === null || (inst.regimeRevision || 0) === requestRevision)) fail(error);
    }
  }

  return { MA_COLORS, render, evaluate, update };
});
