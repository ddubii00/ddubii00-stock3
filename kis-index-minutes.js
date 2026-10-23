'use strict';
const { sessionRows } = require('./korea-index-session');
const MAX_PAGES=5, MAX_ROWS=5000, OPEN_SECONDS=9*3600, CLOSE_SECONDS=(15*60+30)*60;
const numeric=value=>value==null||String(value).trim()===''?null:Number(String(value).replace(/,/g,''));

function parseRows(input,now){
  const rows=[];
  for(const row of Array.isArray(input)?input:[]){
    const day=String(row?.stck_bsop_date||''),hour=String(row?.stck_cntg_hour||'');
    if(!/^\d{8}$/.test(day)||!/^\d{6}$/.test(hour))continue;
    const date=`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}`;
    if(Number(hour.slice(0,2))>23||Number(hour.slice(2,4))>59||Number(hour.slice(4,6))>59)continue;
    // Match the existing chart clock: Korean local date/time encoded as UTC seconds for display.
    const time=Date.parse(`${date}T${hour.slice(0,2)}:${hour.slice(2,4)}:00Z`)/1000;
    if(!Number.isFinite(time)||new Date(time*1000).toISOString().slice(0,10)!==date)continue;
    const open=numeric(row.bstp_nmix_oprc),high=numeric(row.bstp_nmix_hgpr);
    const low=numeric(row.bstp_nmix_lwpr),close=numeric(row.bstp_nmix_prpr);
    if(![open,high,low,close].every(value=>Number.isFinite(value)&&value>0)||high<Math.max(open,close)||low>Math.min(open,close))continue;
    const volume=numeric(row.cntg_vol);
    rows.push({date:time,open,high,low,close,volume:Number.isFinite(volume)&&volume>=0?volume:null,source:'KIS'});
  }
  return sessionRows(rows,now);
}

function aggregateRows(rows,minutes){
  if(minutes===1)return rows;
  const groups=new Map();
  for(const row of rows){
    const day=Math.floor(row.date/86400)*86400,open=day+OPEN_SECONDS;
    const time=row.date-day===CLOSE_SECONDS?row.date:open+Math.floor((row.date-open)/(minutes*60))*minutes*60;
    const old=groups.get(time);
    if(!old)groups.set(time,{...row,date:time,sourceTime:row.date});
    else{
      old.high=Math.max(old.high,row.high);old.low=Math.min(old.low,row.low);old.close=row.close;old.sourceTime=row.date;
      old.volume=Number.isFinite(old.volume)&&Number.isFinite(row.volume)?old.volume+row.volume:null;
    }
  }
  return [...groups.values()];
}

function createReader({get,now=()=>Date.now()}){
  const history=new Map();
  return async config=>{
    const saved=history.get(config.key)||[],merged=new Map(saved.map(row=>[row.date,row]));
    const previousLatest=saved.at(-1)?.date;
    const seen=new Set();
    let continuation='',oldest=Infinity,observed=0;
    for(let page=0;page<MAX_PAGES;page++){
      let response;
      try{
        response=await get('/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice','FHKUP03500200',{
          FID_COND_MRKT_DIV_CODE:'U',FID_ETC_CLS_CODE:'0',FID_INPUT_ISCD:config.code,
          // This is the bar duration in SECONDS, not a HHMMSS pagination cursor.
          FID_INPUT_HOUR_1:'60',FID_PW_DATA_INCU_YN:'Y'
        },continuation);
      }catch(error){if(!observed)throw error;break;}
      const rows=parseRows(response.body.output2,now());
      if(!rows.length)break;
      observed+=rows.length;
      for(const row of rows)if(!seen.has(row.date)){merged.set(row.date,row);seen.add(row.date);}
      const nextOldest=Math.min(...rows.map(row=>row.date));
      if(!['M','F'].includes(response.continuation)||nextOldest>=oldest||
        (previousLatest!==undefined&&nextOldest<=previousLatest))break;
      oldest=nextOldest;continuation='N';
    }
    if(!observed)throw new Error('KIS 지수 분봉 미제공');
    const rows=sessionRows([...merged.values()],now()).sort((a,b)=>a.date-b.date).slice(-MAX_ROWS);
    history.set(config.key,rows);
    return rows;
  };
}
module.exports={parseRows,aggregateRows,createReader};
