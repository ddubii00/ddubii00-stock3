(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StockChartPicker = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (browser) {
  'use strict';
  const valid = (stock) => stock && /^\d{6}$/.test(stock.code) && ['KOSPI','KOSDAQ'].includes(stock.market) &&
    typeof stock.name === 'string' && stock.name.length > 0 && stock.name.length <= 80 && stock.key === `KR:${stock.code}:${stock.market}`;
  const storageKey = (slot) => `stock3-reference-stock:${slot}`;

  function readSelection(slot, initial, storage) {
    try {
      const saved = JSON.parse((storage || browser?.localStorage)?.getItem(storageKey(slot)) || 'null');
      if (valid(saved)) return saved;
    } catch (_) { /* selection persistence is optional */ }
    return initial;
  }

  function attach({ slot, initial, urlFor, onSelect, canSelect = () => true, selectionLabel }) {
    const input = browser.document.getElementById(`stock-search-${slot}`);
    const list = browser.document.getElementById(`stock-results-${slot}`);
    let rows = [], active = -1, generation = 0, timer, selected = initial;
    input.value = initial.name;
    input.title = `${initial.name} · ${initial.code} · ${initial.market}`;
    const close = () => {
      clearTimeout(timer); generation += 1;
      list.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant');
    };
    const show = () => { list.hidden = false; input.setAttribute('aria-expanded','true'); };
    const highlight = () => {
      [...list.querySelectorAll('[role="option"]')].forEach((item,i) => item.setAttribute('aria-selected',String(i === active)));
      if (active >= 0) {
        input.setAttribute('aria-activedescendant',`${slot}-option-${active}`);
        list.querySelectorAll('[role="option"]')[active]?.scrollIntoView({block:'nearest'});
      } else input.removeAttribute('aria-activedescendant');
    };
    const message = (text) => {
      rows = []; active = -1; list.replaceChildren();
      const node = browser.document.createElement('div'); node.className = 'stock-search-message'; node.setAttribute('role','status'); node.textContent = text;
      list.appendChild(node); show();
    };
    const choose = (index) => {
      const stock = rows[index];
      if (!valid(stock)) return;
      if (!canSelect(stock)) { message('이미 표시 중인 종목입니다.'); input.value=selected.name; return; }
      selected = stock;
      close(); input.value = stock.name;
      input.title = `${stock.name} · ${stock.code} · ${stock.market}`;
      input.setAttribute('aria-label',selectionLabel || `${stock.name} 창 종목 검색`);
      try { browser.localStorage.setItem(storageKey(slot),JSON.stringify(stock)); }
      catch (_) { browser.console?.warn('선택 종목을 저장하지 못했습니다.'); }
      Promise.resolve(onSelect(stock)).catch(() => message('종목을 불러오지 못했습니다. 다시 선택하세요.'));
    };
    const search = async () => {
      const query = input.value.trim();
      if (!query) { close(); return; }
      const revision = ++generation;
      message('검색 중…');
      try {
        const response = await browser.fetch(urlFor(`/api/stock-search?q=${encodeURIComponent(query)}`),{cache:'no-store'});
        const json = await response.json();
        if (generation !== revision || input.value.trim() !== query) return;
        if (!response.ok || !json.ok || !Array.isArray(json.rows)) throw new Error('search unavailable');
        rows = json.rows.filter(valid); active = -1; list.replaceChildren();
        if (!rows.length) { message('일치하는 종목이 없습니다.'); return; }
        rows.forEach((stock,index) => {
          const option = browser.document.createElement('button'); option.type = 'button'; option.id = `${slot}-option-${index}`;
          option.setAttribute('role','option'); option.setAttribute('aria-selected','false'); option.tabIndex = -1;
          option.textContent = `${stock.name} · ${stock.code} · ${stock.market}`;
          option.addEventListener('mousedown',(event)=>event.preventDefault());
          option.addEventListener('click',()=>choose(index));
          list.appendChild(option);
        }); show(); highlight();
      } catch (_) { if (generation === revision) message('종목 검색 원천을 확인하지 못했습니다. 다시 검색하세요.'); }
    };
    input.addEventListener('input',() => {
      clearTimeout(timer); generation += 1; rows = []; active = -1; list.replaceChildren();
      if (!input.value.trim()) { close(); return; }
      message('검색 중…'); timer = setTimeout(search,180);
    });
    input.addEventListener('focus',() => { input.select(); void search(); });
    input.addEventListener('keydown',(event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); input.value = selected.name; return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!rows.length || list.hidden) { void search(); return; }
        active = active < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        highlight();
      } else if (event.key === 'Enter' && !list.hidden) {
        event.preventDefault(); if (rows.length) choose(active < 0 ? 0 : active);
      }
    });
    input.addEventListener('blur',()=>{ close(); input.value = selected.name; });
    const outside = (event)=>{ if (!input.parentElement.contains(event.target)) { close(); input.value = selected.name; } };
    browser.document.addEventListener('pointerdown',outside);
    return { close, destroy(){ close(); browser.document.removeEventListener('pointerdown',outside); } };
  }

  return { valid, readSelection, attach };
});
