'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {sessionAt,extendedQuote}=require('../us-market-session');
const {createQuotes}=require('../market-quotes');
const search=require('../stock-search');
const epoch=value=>Date.parse(value)/1000;
const root=path.join(__dirname,'..');

test('US market phases follow New York daylight saving time and source early-close periods',()=>{
  assert.equal(sessionAt(epoch('2026-10-20T08:00:00Z')).label,'장전');
  assert.equal(sessionAt(epoch('2026-10-20T13:30:00Z')).label,'정규장');
  assert.equal(sessionAt(epoch('2026-10-20T20:00:00Z')).label,'장후');
  assert.equal(sessionAt(epoch('2026-12-01T09:00:00Z')).label,'장전');
  assert.equal(sessionAt(epoch('2026-12-01T14:30:00Z')).label,'정규장');
  assert.equal(sessionAt(epoch('2026-12-01T21:00:00Z')).label,'장후');
  const {displayTimestamp}=require('../us-market-session');
  assert.equal(new Date(displayTimestamp(epoch('2026-10-20T13:30:00Z'))*1000).toISOString().slice(11,16),'09:30');
  assert.equal(new Date(displayTimestamp(epoch('2026-12-01T14:30:00Z'))*1000).toISOString().slice(11,16),'09:30');
  assert.equal(sessionAt(epoch('2026-10-24T14:00:00Z')),null);
  assert.equal(sessionAt(epoch('2026-11-27T18:01:00Z'),{post:{start:epoch('2026-11-27T18:00:00Z'),end:epoch('2026-11-28T01:00:00Z')}}).session,'post');
});

test('premarket and postmarket quotes need real timestamps and use the regular close as their change basis',()=>{
  for(const [regularTime,time,label] of [
    ['2026-10-19T20:00:00Z','2026-10-20T12:00:00Z','장전'],
    ['2026-10-20T20:00:00Z','2026-10-20T21:00:00Z','장후']
  ]){
    const result={meta:{regularMarketPrice:100,regularMarketTime:epoch(regularTime)},timestamp:[epoch(time)],indicators:{quote:[{close:[101]}]}};
    const value=extendedQuote(result,Date.parse(time)+60_000);
    assert.equal(value.price,101);assert.equal(value.previousClose,100);assert.equal(value.sessionLabel,label);
    assert.ok(Math.abs(value.changePercent-1)<1e-8);assert.equal(value.asOf,new Date(time).toISOString());
    assert.equal(value.changeBasis,'정규장 종가 대비');
  }
  const base={meta:{regularMarketPrice:100,regularMarketTime:epoch('2026-10-20T20:00:00Z'),postMarketPrice:105}};
  assert.equal(extendedQuote(base,Date.parse('2026-10-20T21:00:00Z')),null);
  base.meta.postMarketTime=epoch('2026-10-20T22:00:00Z');
  assert.equal(extendedQuote(base,Date.parse('2026-10-20T21:00:00Z')),null);
});

test('an old premarket quote never replaces current regular trading or the next postmarket session',()=>{
  const result={meta:{regularMarketPrice:100,regularMarketTime:epoch('2026-10-19T20:00:00Z'),preMarketPrice:105,preMarketTime:epoch('2026-10-20T12:00:00Z')}};
  assert.equal(extendedQuote(result,Date.parse('2026-10-20T14:00:00Z')),null);
  assert.equal(extendedQuote(result,Date.parse('2026-10-20T21:00:00Z')),null);
});

test('extended US price supplements the KIS primary while errors and missing timestamps retain KIS',async()=>{
  for(const mode of ['valid','missing','error']){
    const primary={price:100,previousClose:99,changePercent:1,source:'KIS'};
    const reader=createQuotes({now:()=>Date.parse('2026-10-20T21:01:00Z'),kisClient:{quote:async()=>({...primary})},fetchImpl:async url=>{
      assert.equal(new URL(url).searchParams.get('includePrePost'),'true');
      if(mode==='error')throw new Error('offline');
      return{ok:true,json:async()=>({chart:{result:[{meta:{regularMarketPrice:100,regularMarketTime:epoch('2026-10-20T20:00:00Z'),postMarketPrice:102,...(mode==='valid'?{postMarketTime:epoch('2026-10-20T21:00:00Z')}:{})}}]}})};
    }});
    const quote=await reader.quote('US:AAPL:NASDAQ');
    assert.equal(quote.price,mode==='valid'?102:100);
    assert.equal(quote.sessionLabel,mode==='valid'?'장후':'정규장');
    assert.equal(quote.source,mode==='valid'?'Yahoo Finance':'KIS');
  }
});

test('US minute charts request extended bars while daily candles stay on their regular-session input',async()=>{
  const calls=[];
  const context=vm.createContext({module:{exports:{}},URL,Buffer,setTimeout,clearTimeout,
    require:id=>id==='./kis-market-data'?{series:async()=>null}:id==='./stock-search'?search:id==='./us-market-session'?require('../us-market-session'):class{constructor(){throw new Error('Unexpected WebSocket');}},
    fetch:async url=>{calls.push(new URL(url));return{ok:true,json:async()=>({chart:{result:[{meta:{gmtoffset:-14400},timestamp:[epoch('2026-10-20T12:00:00Z'),epoch('2026-10-20T21:00:00Z')],indicators:{quote:[{open:[100,101],high:[101,102],low:[99,100],close:[100,102]}]}}]}})};}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'tradingview-data.js'),'utf8'),context);
  const rows=await context.module.exports.fetchUnifiedSeries('US:AAPL:NASDAQ','1m');
  assert.equal(calls[0].searchParams.get('includePrePost'),'true');
  assert.equal(new Date(rows[0].date*1000).toISOString().slice(11,16),'08:00');
  assert.equal(new Date(rows[1].date*1000).toISOString().slice(11,16),'17:00');
  await context.module.exports.fetchUnifiedSeries('US:AAPL:NASDAQ','1d');
  assert.equal(calls[1].searchParams.has('includePrePost'),false);
});
