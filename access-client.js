(function () {
  'use strict';
  const base = location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
  const key = `stock3-access:${base}`;
  const nativeFetch = window.fetch.bind(window);
  let password = '', unlock;
  try { password = localStorage.getItem(key) || ''; } catch (_) { /* optional persistence */ }
  const ready = new Promise((resolve) => { unlock = resolve; });
  const form = document.getElementById('accessForm');
  const error = document.getElementById('accessError');
  async function login(value) {
    const response = await nativeFetch(`${base}/api/access`, {cache:'no-store',redirect:'error',headers:{'x-stock3-password':value}});
    if (!response.ok) throw new Error('접속 암호를 확인하세요.');
    const json = await response.json();
    if (!json.ok) throw new Error('접속 암호를 확인하세요.');
    password = value;
    try { localStorage.setItem(key,value); } catch (_) { /* access works without storage */ }
    document.getElementById('accessGate').hidden = true;
    document.getElementById('marketHeader').hidden = false;
    document.body.removeAttribute('data-locked');
    unlock();
  }
  window.fetch = async function(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.includes('/api/')) return nativeFetch(input,options);
    await ready;
    const headers = new Headers(options.headers || (typeof input === 'object' ? input.headers : undefined));
    headers.set('x-stock3-password',password);
    const response = await nativeFetch(input,{...options,headers,redirect:'error'});
    if (response.status === 401) {
      try { localStorage.removeItem(key); } catch (_) { /* optional persistence */ }
      location.reload();
    }
    return response;
  };
  form.addEventListener('submit',async (event) => {
    event.preventDefault(); error.textContent = '';
    const button = form.querySelector('button'); button.disabled = true;
    try { await login(document.getElementById('accessPassword').value); }
    catch (failure) { error.textContent = failure.message || '접속 상태를 확인하세요.'; }
    finally { button.disabled = false; }
  });
  window.Stock3Access = { ready };
  if (password) login(password).catch(() => {
    try { localStorage.removeItem(key); } catch (_) { /* optional persistence */ }
    error.textContent = '접속 암호를 다시 입력하세요.';
  });
})();
