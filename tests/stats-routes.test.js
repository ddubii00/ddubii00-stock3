'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function series(value) {
  return Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, dailyForeign: value }));
}

async function coreStats(payload, program = null, configured = true, gatewayOwned = false) {
  let handler;
  const calls = [],sourceCalls={futures:0,program:0};
  const context = vm.createContext({
    module: { exports: {} }, __dirname: root, process: { env: gatewayOwned?{STOCK3_KIS_FLOW_OWNER:'gateway'}:{} }, payload, program, calls, configured, sourceCalls,
    URL, console, setTimeout, clearTimeout, setInterval, AbortController,
    require: (id) => {
      if (id === 'http') return { createServer: (callback) => { handler = callback; return {}; } };
      if (id === 'path') return path;
      if (id === 'fs') return { readFileSync: () => { throw new Error('File reads forbidden in stats tests'); } };
      if (id === 'ws') return {};
      if (id === './access-control') return require('../access-control');
      if (id === './flow-stats') return require('../flow-stats');
      if (id.startsWith('./')) return {};
      throw new Error(`Unexpected require ${id}`);
    },
    fetch: () => { throw new Error('Live network is forbidden in tests'); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8') + `
    getLatestMarketOpenDate = async () => '2026-09-20';
    getKoreaClock = () => ({ date: '2026-09-20', minutes: 600 });
    fetchMarketTurnoverRows = async () => [];
    fetchForeignFuturesSeries = async () => {sourceCalls.futures++;return payload;};
    fetchProgramFlowArray = async () => {sourceCalls.program++;return program;};
    fetchKisInvestorSnapshot = async (kind) => { calls.push(kind); return { foreign: 7899 }; };
    hasKisInvestorConfig = () => configured;
  `, context);
  let result;
  await handler({ url: '/api/stats', headers: { host: 'localhost', 'x-stock3-password':'1222' } }, {
    writeHead: () => {}, end: (body) => { result = JSON.parse(body); },
  });
  return { result, calls, sourceCalls };
}

test('configured Oracle stats selects a KIS contract row without filling it from spot history', async () => {
  const { result, calls } = await coreStats({ unit: '조원', source: 'spot-fallback', series: series(0.35) }, { values: [null, 0, null, 25, null], source: 'KIS' });
  assert.equal(calls.length, 1);
  assert.equal(result.futuresLatest.value,7899);
  assert.equal(result.futuresLatest.unit,'계약');
  assert.deepEqual(result.futuresArray, [7899, null, null, null, null]);
  assert.equal(result.futuresMode, 'futures');
  assert.equal(result.futuresUnit, '계약');
  assert.deepEqual(result.progsArray, [null, 0, null, 25, null]);
  assert.equal(result.programSource, 'KIS');
});

test('Oracle stats permits KIS live merging only for contract history', async () => {
  const { result, calls } = await coreStats({ unit: '계약', series: series(100) });
  assert.equal(calls.length, 1);
  assert.equal(result.futuresArray[0], 7899);
  assert.equal(result.futuresUnit, '계약');
  assert.equal(result.progsArray, null);
});

test('Oracle stats retains a KIS current contract value when public history is unavailable', async () => {
  const { result, calls } = await coreStats(null);
  assert.equal(calls.length, 1);
  assert.equal(result.futuresLatest.value,7899);
  assert.deepEqual(result.futuresArray,[7899,null,null,null,null]);
  assert.equal(result.progsArray, null);
  assert.equal(result.programSource, 'unavailable');
});

async function vercelStats(payload, failed = false) {
  const context = vm.createContext({
    module: { exports: {} }, URL, Date, Buffer, TextDecoder, AbortController, setTimeout, clearTimeout,
    require: (id) => id === '../access-control' ? require('../access-control') : id === '../server' ? { fetchForeignFuturesSeries: async () => payload } : require('../flow-stats'),
    fetch: async (url) => {
      if (failed) throw new Error('mock source unavailable');
      if (url.includes('programDealTrendDay')) return { ok: true, arrayBuffer: async () => Buffer.from('<html></html>') };
      return { ok: true, text: async () => JSON.stringify({ data: [{ date: '2026-09-20', accTradePrice: 100 }] }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'api/stats.js'), 'utf8'), context);
  let result;
  await context.module.exports({ method: 'GET',headers:{'x-stock3-password':'1222'} }, { setHeader: () => {}, end: (body) => { result = JSON.parse(body); } });
  return result;
}

test('Vercel stats uses the same spot units and preserves program unavailability', async () => {
  const result = await vercelStats({ source: 'spot-fallback', unit: '조원', series: series(0.35) });
  assert.deepEqual(result.futuresArray, [3500, 10500, 17500, 35000, 70000]);
  assert.equal(result.futuresUnit, '억원');
  assert.equal(result.futuresMode, 'spot-fallback');
  assert.equal(result.progsArray, null);
  assert.equal(result.programSource, 'unavailable');
});

test('Vercel source failure cannot fabricate zero flow arrays', async () => {
  const result = await vercelStats(null, true);
  assert.equal(result.futuresArray, null);
  assert.equal(result.progsArray, null);
});

test('an unconfigured server preserves the existing spot fallback rather than inventing KIS contracts',async()=>{
  const {result,calls}=await coreStats({unit:'조원',source:'spot-fallback',series:series(0.35)},null,false);
  assert.equal(calls.length,0);assert.equal(result.futuresMode,'spot-fallback');assert.equal(result.futuresUnit,'억원');
  assert.deepEqual(result.futuresArray,[3500,10500,17500,35000,70000]);
});

test('a gateway-owned core does not query public flow fallbacks or duplicate the program request',async()=>{
  const {sourceCalls}=await coreStats(null,null,false,true);
  assert.deepEqual(sourceCalls,{futures:0,program:0});
});
