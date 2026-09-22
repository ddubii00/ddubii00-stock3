'use strict';

(() => {
  const TABLES = [
    { bodyId: 'breakoutTableBody', tableName: '신고가' },
    { bodyId: 'lowBreakoutTableBody', tableName: '신저가' },
  ];

  let marketCaps = new Map();
  let refreshPending = null;

  function apiUrl() {
    const base = location.pathname
      .replace(/\/index\.html$/, '')
      .replace(/\/$/, '');
    return `${base}/api/high-breakouts`;
  }

  function formatTrillion(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '-';
    return (number / 1e12).toLocaleString('ko-KR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function codeFromRow(row) {
    const kicker = row.querySelector('.kicker');
    const code = String(kicker?.textContent || '').trim();
    return /^[A-Za-z0-9.^-]{1,24}$/.test(code) ? code : '';
  }

  function ensureHeader(body) {
    const table = body.closest('table');
    const headRow = table?.querySelector('thead tr');
    if (!headRow) return;

    if (!headRow.querySelector('th[data-marketcap-head]')) {
      const stockHead = headRow.children[1];
      if (stockHead) {
        const th = document.createElement('th');
        th.dataset.marketcapHead = '1';
        th.textContent = '시가총액(조)';
        th.title = '네이버 증권 marketSum 기준 · 원 단위를 조원으로 환산';
        stockHead.insertAdjacentElement('afterend', th);
      }
    }
  }

  function decorateBody(body) {
    ensureHeader(body);

    for (const row of body.querySelectorAll('tr')) {
      // Loading / empty rows use one colspan cell.
      if (row.children.length === 1 && row.firstElementChild?.hasAttribute('colspan')) {
        row.firstElementChild.colSpan = 11;
        continue;
      }

      if (row.querySelector('td[data-marketcap-cell]')) continue;

      const code = codeFromRow(row);
      if (!code) continue;

      const stockCell = row.children[1];
      if (!stockCell) continue;

      const td = document.createElement('td');
      td.dataset.marketcapCell = '1';
      td.style.fontWeight = '850';
      td.style.textAlign = 'right';
      td.style.fontVariantNumeric = 'tabular-nums';
      td.textContent = formatTrillion(marketCaps.get(code));
      stockCell.insertAdjacentElement('afterend', td);
    }
  }

  function decorateAll() {
    for (const { bodyId } of TABLES) {
      const body = document.getElementById(bodyId);
      if (body) decorateBody(body);
    }
  }

  async function refreshMarketCaps() {
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try {
        const response = await fetch(apiUrl(), { cache: 'no-store' });
        const json = await response.json();
        if (!response.ok || !json?.ok) return;

        const next = new Map();
        for (const row of [...(json.rows || []), ...(json.lowRows || [])]) {
          const code = String(row?.code || '').trim();
          const marketCap = Number(row?.marketCap);
          if (code && Number.isFinite(marketCap) && marketCap > 0) {
            next.set(code, marketCap);
          }
        }
        marketCaps = next;

        // Existing cells may have been drawn before the API data arrived.
        document.querySelectorAll('td[data-marketcap-cell]').forEach((cell) => cell.remove());
        decorateAll();
      } catch (_) {
        // Keep the dashboard usable even if the auxiliary market-cap fetch fails.
      } finally {
        refreshPending = null;
      }
    })();
    return refreshPending;
  }

  function observe() {
    for (const { bodyId } of TABLES) {
      const body = document.getElementById(bodyId);
      if (!body) continue;
      decorateBody(body);
      new MutationObserver(() => decorateBody(body)).observe(body, {
        childList: true,
        subtree: true,
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    observe();
    void refreshMarketCaps();

    for (const id of ['refreshBreakouts', 'refreshLowBreakouts']) {
      document.getElementById(id)?.addEventListener('click', () => {
        setTimeout(() => { void refreshMarketCaps(); }, 600);
      });
    }

    // The breakout API itself is cached for three minutes. This keeps the
    // market-cap labels fresh without adding high-frequency traffic.
    setInterval(() => { void refreshMarketCaps(); }, 3 * 60 * 1000);
  });
})();
