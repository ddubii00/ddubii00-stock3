'use strict';

const CALENDAR_TTL=24*60*60_000,RETRY_MS=60_000;
function dashed(value){
  const text=String(value||'').replace(/-/g,'');
  if(!/^\d{8}$/.test(text))return '';
  const date=`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}`,stamp=Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date?date:'';
}
function createSessionDateReader({request,publishedDate,clock,now=()=>Date.now()}){
  let calendar=null,published=null,pending=null;
  const rows=json=>Array.isArray(json?.output)?json.output:json?.output?[json.output]:[];
  const openDates=(items,today)=>items.filter(row=>String(row.opnd_yn).toUpperCase()==='Y').map(row=>dashed(row.bass_dt)).filter(date=>date&&date<=today).sort();
  async function load(force){
    const current=clock(),at=now();
    if(force||calendar?.day!==current.date||calendar.until<=at){
      let latest='',previous='',open=null;
      try{
        // Query today's row directly: an old base date can return a page that
        // ends before today. A weekday alone never proves that the market opened.
        const items=rows(await request('/uapi/domestic-stock/v1/quotations/chk-holiday','CTCA0903R',{BASS_DT:current.date.replace(/-/g,''),CTX_AREA_FK:'',CTX_AREA_NK:''}));
        const today=items.find(row=>dashed(row.bass_dt)===current.date);
        if(['Y','N'].includes(String(today?.opnd_yn).toUpperCase()))open=String(today.opnd_yn).toUpperCase()==='Y';
        latest=openDates(items,current.date).at(-1)||'';
        previous=openDates(items,current.date).filter(date=>date<current.date).at(-1)||'';
        if(!latest||current.minutes<8*60+45){
          const base=new Date(`${current.date}T00:00:00Z`);base.setUTCDate(base.getUTCDate()-14);
          const history=rows(await request('/uapi/domestic-stock/v1/quotations/chk-holiday','CTCA0903R',{BASS_DT:base.toISOString().slice(0,10).replace(/-/g,''),CTX_AREA_FK:'',CTX_AREA_NK:''}));
          previous=openDates(history,current.date).filter(date=>date<current.date).at(-1)||previous;
          if(!latest)latest=previous;
        }
      }catch(_){/* dated public observations may still establish the session */}
      // Set expiry only on a real attempt, never on a cache hit. Incomplete
      // calendar publication is retried; it cannot pin Friday for all of Monday.
      calendar={day:current.date,latest,previous,open,until:at+(open===null||!latest?RETRY_MS:CALENDAR_TTL)};
    }
    let calendarDate=calendar.latest;
    if(current.minutes<8*60+45&&calendarDate===current.date)calendarDate=calendar.previous;
    if(calendarDate===current.date){return current.date;}
    if(force||published?.day!==current.date||published.until<=at){
      let date='';
      try{date=dashed(await publishedDate());}catch(_){}
      published={day:current.date,date,until:at+(current.minutes>=8*60+45&&current.minutes<=16*60?RETRY_MS:15*60_000)};
    }
    const weekend=[0,6].includes(new Date(`${current.date}T00:00:00Z`).getUTCDay());
    const candidates=[calendarDate,published.date].filter(date=>date&&date<=current.date&&
      (date!==current.date||(!weekend&&calendar.open!==false&&current.minutes>=8*60+45)));
    const latest=candidates.sort().at(-1);
    if(!latest)throw Object.assign(new Error('최근 개장일을 확인하지 못했습니다.'),{code:'SESSION_UNCONFIRMED'});
    return latest;
  }
  return {latest(force=false){
    if(pending)return pending;
    pending=load(force).finally(()=>{pending=null;});return pending;
  }};
}
module.exports={createSessionDateReader};
