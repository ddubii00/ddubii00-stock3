'use strict';

function clock(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(timestamp * 1000)).map(part => [part.type, part.value]));
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minute:Number(parts.hour)*60+Number(parts.minute), weekday:parts.weekday };
}

function displayTimestamp(timestamp) {
  const local = clock(timestamp);
  return Date.parse(`${local.date}T00:00:00Z`)/1000 + local.minute*60;
}

function sessionAt(timestamp, periods) {
  for (const [session, label] of [['pre','장전'],['regular','정규장'],['post','장후']]) {
    const period = periods?.[session];
    if (Number.isFinite(period?.start) && Number.isFinite(period?.end) && timestamp >= period.start && timestamp < period.end) return { session, label };
  }
  const local = clock(timestamp);
  if (['Sat','Sun'].includes(local.weekday)) return null;
  if (local.minute >= 4*60 && local.minute < 9*60+30) return { session:'pre', label:'장전' };
  if (local.minute >= 9*60+30 && local.minute < 16*60) return { session:'regular', label:'정규장' };
  if (local.minute >= 16*60 && local.minute < 20*60) return { session:'post', label:'장후' };
  return null;
}

function extendedQuote(result, now = Date.now()) {
  const meta = result?.meta || {}, cutoff = now / 1000;
  const regularPrice = Number(meta.regularMarketPrice), regularTime = Number(meta.regularMarketTime);
  if (!(regularPrice > 0) || !(regularTime > 0)) return null;
  const candidates = [];
  const add = (timestamp, price) => {
    if (price == null || String(price).trim() === '') return;
    const time = Number(timestamp), value = Number(price);
    if (!Number.isFinite(time) || time <= regularTime || time > cutoff || !(value > 0) || !Number.isFinite(value)) return;
    const period = sessionAt(time, meta.currentTradingPeriod);
    if (period?.session === 'pre' || period?.session === 'post') candidates.push({ time, price:value, ...period });
  };
  add(meta.preMarketTime, meta.preMarketPrice);
  add(meta.postMarketTime, meta.postMarketPrice);
  const closes = result?.indicators?.quote?.[0]?.close || [];
  (result?.timestamp || []).forEach((time, index) => add(time, closes[index]));
  const latest = candidates.sort((a,b) => b.time-a.time)[0];
  if (!latest) return null;
  const current = sessionAt(cutoff, meta.currentTradingPeriod);
  if (current?.session === 'regular') return null;
  if (current && (latest.session !== current.session || clock(latest.time).date !== clock(cutoff).date)) return null;
  return { price:latest.price, previousClose:regularPrice, changePercent:(latest.price/regularPrice-1)*100,
    regularPrice, session:latest.session, sessionLabel:latest.label, changeBasis:'정규장 종가 대비',
    asOf:new Date(latest.time*1000).toISOString() };
}

module.exports = { clock, displayTimestamp, sessionAt, extendedQuote };
