'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSessionDateReader}=require('../kis-session-date');
function fixture({time='2026-10-26T10:00:00+09:00',calendar=()=>[{bass_dt:'20261026',opnd_yn:'Y'}],published=()=> '2026-10-23'}={}){
  let at=Date.parse(time);const calls=[];
  const clock=()=>{
    const d=new Date(at+9*60*60_000);
    return {date:d.toISOString().slice(0,10),minutes:d.getUTCHours()*60+d.getUTCMinutes(),weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]};
  };
  const reader=createSessionDateReader({now:()=>at,clock,request:async(path,tr,params)=>{calls.push(params);return{output:await calendar(params,clock())};},publishedDate:async()=>published(clock())});
  return {reader,calls,setTime:value=>{at=Date.parse(value);}};
}
test('today is queried directly and wins over Friday public data during and after Monday trading',async()=>{
  const f=fixture();assert.equal(await f.reader.latest(),'2026-10-26');assert.equal(f.calls[0].BASS_DT,'20261026');
  f.setTime('2026-10-26T16:00:00+09:00');assert.equal(await f.reader.latest(),'2026-10-26');assert.equal(f.calls.length,1);
});
test('Friday cache cannot carry into Monday; simultaneous visitors share a single calendar read',async()=>{
  const f=fixture({time:'2026-10-23T14:00:00+09:00',calendar:(_params,clock)=>[{bass_dt:clock.date.replace(/-/g,''),opnd_yn:'Y'}]});
  assert.equal(await f.reader.latest(),'2026-10-23');f.setTime('2026-10-26T09:00:00+09:00');
  assert.deepEqual(await Promise.all(Array.from({length:8},()=>f.reader.latest())),Array(8).fill('2026-10-26'));assert.equal(f.calls.length,2);
});
test('Saturday, Sunday and an explicit weekday holiday use the last real open date',async()=>{
  for(const day of ['2026-10-24','2026-10-25','2026-10-26']){
    const f=fixture({time:`${day}T14:00:00+09:00`,calendar:params=>params.BASS_DT===day.replace(/-/g,'')?[{bass_dt:params.BASS_DT,opnd_yn:'N'}]:[{bass_dt:'20261023',opnd_yn:'Y'}],published:()=>day});
    assert.equal(await f.reader.latest(),'2026-10-23');
  }
});
test('an incomplete calendar retries after one minute despite continuous twenty-second visitors',async()=>{
  let ready=false;
  const f=fixture({calendar:()=>ready?[{bass_dt:'20261026',opnd_yn:'Y'}]:[{bass_dt:'20261023',opnd_yn:'Y'}]});
  assert.equal(await f.reader.latest(),'2026-10-23');ready=true;
  for(const second of ['20','40']){f.setTime(`2026-10-26T10:00:${second}+09:00`);assert.equal(await f.reader.latest(),'2026-10-23');}
  f.setTime('2026-10-26T10:01:00+09:00');assert.equal(await f.reader.latest(),'2026-10-26');assert.equal(f.calls.length,2);
});
test('dated public publication can prove today when the calendar is unavailable; unknown is never fabricated',async()=>{
  const f=fixture({calendar:()=>{throw new Error('offline');},published:()=> '2026-10-26'});
  assert.equal(await f.reader.latest(),'2026-10-26');
  const missing=fixture({calendar:()=>{throw new Error('offline');},published:()=>''});
  await assert.rejects(missing.reader.latest(),{code:'SESSION_UNCONFIRMED'});
});
test('before the first market opens, future calendar dates and today are excluded',async()=>{
  const f=fixture({time:'2026-10-26T08:44:00+09:00',calendar:params=>params.BASS_DT==='20261026'?[{bass_dt:'20261026',opnd_yn:'Y'},{bass_dt:'20261027',opnd_yn:'Y'}]:[{bass_dt:'20261023',opnd_yn:'Y'}],published:()=> '2026-10-26'});
  assert.equal(await f.reader.latest(),'2026-10-23');f.setTime('2026-10-26T08:45:00+09:00');assert.equal(await f.reader.latest(),'2026-10-26');
});
