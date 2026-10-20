'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const session = require('../korea-index-session');
const date = '2026-10-20';
const stamp = (time, day = date) => Date.parse(`${day}T${time}:00Z`) / 1000;
const clock = time => Date.parse(`${date}T${time}:00+09:00`);
const bar = (time, close = 100) => ({ date: stamp(time), open: close, high: close, low: close, close });
const ok = body => ({ ok: true, json: async () => body });

test('Korean minute display includes 15:19, removes auction minutes and gates 15:30 until 15:31', () => {
  const rows = ['08:59','09:00','14:59','15:00','15:19','15:20','15:29','15:30','15:31'].map(time => bar(time));
  for (const time of ['15:20','15:30']) {
    assert.deepEqual(session.sessionRows(rows, clock(time)).map(row => row.date), ['09:00','14:59','15:00','15:19'].map(time => stamp(time)));
  }
  assert.deepEqual(session.sessionRows(rows, clock('15:31')).map(row => row.date), ['09:00','14:59','15:00','15:19','15:30'].map(time => stamp(time)));
  assert.deepEqual(session.sessionRows(rows, clock('14:59')).map(row => row.date), ['09:00','14:59'].map(time => stamp(time)));
});

test('a source timestamp must be present and belong to the requested session', () => {
  assert.equal(session.snapshotTime({time:'15:19:00'},date),stamp('15:19'));
  assert.equal(session.snapshotTime({localTradedAt:`${date}T15:30:00+09:00`},date),stamp('15:30'));
  assert.equal(session.snapshotTime({thistime:'20261020151900'},date),stamp('15:19'));
  for(const row of [{},{time:'25:01'},{time:'15:61'},{localTradedAt:'2026-10-19T15:19:00'}])assert.equal(session.snapshotTime(row,date),null);
});

test('missing late minutes are filled from timed source observations without inventing auction values or minute OHLC', async () => {
  const calls=[];
  const reader=session.createReader({now:()=>clock('15:29'),fetchImpl:async url=>{
    calls.push(url);
    return ok(new URL(url).searchParams.get('startIdx')==='1' ? [
      {time:'15:30',nowVal:'999'},{time:'15:20',nowVal:'888'},
      ...Array.from({length:20},(_,i)=>({time:`15:${String(i).padStart(2,'0')}`,nowVal:String(100+i),openVal:'50',highVal:'500',lowVal:'1'}))
    ] : [{nowVal:'1000'},{localTradedAt:'2026-10-19T15:19:00',nowVal:'900'}]);
  }});
  const result=await reader.supplement('KOSPI',[bar('14:59',99)],'1m');
  assert.equal(result.length,21);assert.equal(result.at(-1).date,stamp('15:19'));
  assert.deepEqual(result.at(-1),bar('15:19',119));
  assert.equal(calls.length,2);assert.ok(calls.every(url=>new URL(url).searchParams.get('thistime')==='20261020'));
  await reader.supplement('KOSPI',[bar('14:59')],'5m');assert.equal(calls.length,2);
});

test('larger candles aggregate late observations and keep the auction close at its own 15:30 timestamp', async () => {
  const reader=session.createReader({now:()=>clock('15:31'),fetchImpl:async url=>ok(url.includes('/price?') ? [
    {localTradedAt:`${date}T15:30:00`,closePrice:'130'}
  ] : [{time:'15:15',nowVal:'110'},{time:'15:19',nowVal:'120'},{time:'15:29',nowVal:'999'}])});
  const source={date:stamp('15:15'),open:105,high:115,low:100,close:111};
  const result=await reader.supplement('KOSDAQ',[source,bar('15:20',999)],'5m');
  assert.deepEqual(result,[{...source,high:120,close:120},bar('15:30',130)]);
  const hourly=await reader.supplement('KOSDAQ',[bar('14:00')],'60m');
  assert.equal(hourly.at(-1).date,stamp('15:30'));assert.equal(hourly.at(-1).close,130);
});

test('stale intraday daily price cannot masquerade as a final close, while an updated close replaces cached data', async () => {
  let now=clock('15:30'),published=false;
  const reader=session.createReader({now:()=>now,fetchImpl:async url=>ok(url.includes('/price?') ? [
    {localTradedAt:`${date}T${published?'15:30':'15:00'}:00`,closePrice:published?'130':'110'}
  ] : [])});
  assert.equal((await reader.supplement('KOSPI',[bar('14:59')],'1m')).length,1);
  now=clock('15:31');assert.equal((await reader.supplement('KOSPI',[bar('14:59')],'1m')).length,1);
  published=true;now+=20_000;
  assert.equal((await reader.supplement('KOSPI',[bar('14:59')],'1m')).at(-1).close,130);
});

test('source failures preserve real observations without filling missing minutes and historical closes remain available', async () => {
  const reader=session.createReader({now:()=>clock('15:31'),fetchImpl:async()=>{throw new Error('offline');}});
  const result=await reader.supplement('KOSPI',[bar('14:59'),bar('15:25'),bar('15:30')],'1m');
  assert.deepEqual(result,[bar('14:59'),bar('15:30')]);
  const previous=[{...bar('15:30'),date:stamp('15:30','2026-10-19')}];
  assert.equal(session.sessionRows(previous,clock('09:00')).length,1);
});

test('Oracle and Vercel apply the same session correction even when the primary source succeeds early', async () => {
  const root=path.join(__dirname,'..');
  for(const file of ['server.js','utils.js']){
    const source=fs.readFileSync(path.join(root,file),'utf8');
    const start=source.indexOf('async function fetchChartSeries(');
    const end=source.indexOf('\n}\n',start)+2;
    const calls=[];
    const context=vm.createContext({fetchUnifiedSeries:async()=>[bar('14:59')],supplementKoreanIndexMinutes:async(...args)=>{calls.push(args);return[bar('15:19')];}});
    // Only the function is needed; later declarations are harmless and not invoked.
    vm.runInContext(source.slice(start,end),context);
    const result=await context.fetchChartSeries('KOSPI','1m');
    assert.equal(calls.length,1);assert.equal(result[0].date,stamp('15:19'));
  }
});
