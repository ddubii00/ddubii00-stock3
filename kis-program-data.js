'use strict';
const {programNetEok,sumWindows,nullableArray}=require('./flow-stats');
const DAILY='/uapi/domestic-stock/v1/quotations/comp-program-trade-daily';
const TODAY='/uapi/domestic-stock/v1/quotations/comp-program-trade-today';
const COMMON={FID_COND_MRKT_DIV_CODE:'J',FID_MRKT_CLS_CODE:'K'};
function outputRows(json) {
  return ['output','output1'].flatMap(key=>{
    const value=json?.[key];
    if(Array.isArray(value))return value;
    if(value && typeof value==='object'&&!Array.isArray(value))return [value];
    return [];
  });
}
function date(value) {
  const raw=String(value || '').replace(/-/g,'');
  if(!/^\d{8}$/.test(raw))return '';
  const result=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  const time=Date.parse(`${result}T00:00:00Z`);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===result?result:'';
}
function parseDaily(json) {
  const rows=new Map();
  for(const row of outputRows(json)) {
    const day=date(row?.stck_bsop_date),value=programNetEok(row);
    if(day&&Number.isFinite(value))rows.set(day,{date:day,value});
  }
  return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
function parseCurrent(json) {
  return outputRows(json).flatMap(row=>{
    const raw=String(row?.bsop_hour ?? '').trim();
    const hour=/^\d{5,6}$/.test(raw)?raw.padStart(6,'0'):'';
    const value=programNetEok(row),day=date(row?.stck_bsop_date);
    if(row?.stck_bsop_date!=null&&String(row.stck_bsop_date).trim()&&!day)return [];
    if(!/^\d{6}$/.test(hour)||hour<'090000'||hour>'170000'||Number(hour.slice(2,4))>59||Number(hour.slice(4))>59||!Number.isFinite(value))return [];
    // Official KIS: 15:30–17:00 rows repeat the same regular-session close.
    const close=hour>='153000';
    return [{hour,hhmm:close?'15:30':`${hour.slice(0,2)}:${hour.slice(2,4)}`,value,...(day?{date:day}:{}),...(close?{final:true}:{})}];
  }).sort((a,b)=>a.hour.localeCompare(b.hour));
}
function safeCode(error) {
  if(['AbortError','TimeoutError'].includes(error?.name))return 'TIMEOUT';
  const value=String(error?.kisCode || error?.code || 'SOURCE_ERROR');
  return /^[A-Z0-9_]{1,32}$/.test(value)?value:'SOURCE_ERROR';
}
function failure(code) {return Object.assign(new Error('KIS 프로그램 원천 조회 실패'),{kisCode:code});}
function createProgramReader({request,now=()=>Date.now()}={}) {
  const cache=new Map(),pending=new Map();
  async function memo(key,ttl,load){
    const saved=cache.get(key);
    if(saved?.until>now()){if(saved.error)throw saved.error;return saved.value;}
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{try{const value=await load();cache.set(key,{value,until:now()+ttl});return value;}catch(error){cache.set(key,{error,until:now()+20_000});throw error;}finally{pending.delete(key);}})();
    pending.set(key,task);return task;
  }
  async function checked(path,tr,params){
    const json=await request(path,tr,params);
    if(String(json?.rt_cd)!=='0')throw failure(/^[A-Z0-9_]{1,32}$/.test(String(json?.msg_cd))?json.msg_cd:'API_ERROR');
    return json;
  }
  async function history(endDate){
    return memo(`daily:${endDate}`,5*60_000,async()=>{
      let last;
      // Some responses reject/empty a long date range. Retry a recent month,
      // which normally contains enough published sessions for a 20-day total.
      for(const days of [120,30]) {
        const start=new Date(`${endDate}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-days);
        try{
          const json=await checked(DAILY,'FHPPG04600001',{...COMMON,FID_INPUT_DATE_1:start.toISOString().slice(0,10).replace(/-/g,''),FID_INPUT_DATE_2:endDate.replace(/-/g,'')});
          const rows=parseDaily(json).filter(row=>row.date<=endDate);
          if(!rows.length)throw failure('NO_DAILY_FIELDS');
          return rows;
        }catch(error){last=error;if(safeCode(error)!=='NO_DAILY_FIELDS')break;}
      }
      throw last;
    });
  }
  async function current(){
    return memo('current',20_000,async()=>{
      const json=await checked(TODAY,'FHPPG04600101',{...COMMON,FID_SCTN_CLS_CODE:'',FID_INPUT_ISCD:'',FID_COND_MRKT_DIV_CODE1:'',FID_INPUT_HOUR_1:''});
      const rows=parseCurrent(json);
      if(!rows.length)throw failure('NO_TIME_FIELDS');
      return rows;
    });
  }
  async function summary(latestDate,clock){
    const diagnostics={history:{ok:false,code:'NOT_QUERIED',rows:0},current:{ok:false,code:'NOT_QUERIED',rows:0}};
    const [dayResult,timeResult]=await Promise.allSettled([history(latestDate),current()]);
    let daily=[],live=null;
    if(dayResult.status==='fulfilled'){daily=dayResult.value;diagnostics.history={ok:true,code:'OK',rows:daily.length};}
    else diagnostics.history.code=safeCode(dayResult.reason);
    if(timeResult.status==='fulfilled'){
      const eligible=timeResult.value.filter(row=>{
        const minute=Number(row.hour.slice(0,2))*60+Number(row.hour.slice(2,4));
        if(latestDate===clock.date&&minute>clock.minutes)return false;
        return row.date?row.date===latestDate:(latestDate===clock.date&&clock.minutes>=9*60);
      });
      live=eligible.at(-1)||null;
      diagnostics.current={ok:Boolean(live),code:live?'OK':'DATE_UNCONFIRMED',rows:eligible.length};
    }else diagnostics.current.code=safeCode(timeResult.reason);
    const byDate=new Map(daily.map(row=>[row.date,row]));
    if(live)byDate.set(latestDate,{date:latestDate,value:live.value});
    const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-60);
    const asOf=rows.at(-1)?.date || '';
    // An older published day remains dated as such; it is never called today's value.
    const windows=sumWindows(rows);
    const values=asOf===latestDate?nullableArray(windows):null;
    return {values,rows,latestOpenDate:latestDate,asOfDate:asOf,asOfHour:live?.hour || '',coverageDays:rows.length,
      source:values?'KIS FHPPG04600001/FHPPG04600101':'unavailable',diagnostics,
      error:values?'':`KIS 프로그램 조회 확인: 일별 ${diagnostics.history.code} · 시간별 ${diagnostics.current.code}${asOf?` · 마지막 자료 ${asOf}`:''}`};
  }
  return {history,current,summary};
}
module.exports={DAILY,TODAY,parseDaily,parseCurrent,createProgramReader,safeCode};
