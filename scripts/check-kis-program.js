'use strict';
// Run under the service's existing environment. Never load a credential file or
// print request headers, OAuth responses, environment values or raw API bodies.
const kis=require('../kis-market-data');
const {createProgramReader}=require('../kis-program-data');
async function main({env=process.env,client=kis,fetchImpl=(...args)=>fetch(...args),now=new Date(),targetDate,write=value=>console.log(JSON.stringify(value,null,2))}={}) {
  const clockParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(part=>[part.type,part.value]));
  const clockDate=`${clockParts.year}-${clockParts.month}-${clockParts.day}`;
  const day=targetDate || clockDate;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(`${day}T00:00:00Z`))||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)throw new Error('거래일 형식을 확인하세요.');
  const {appKey,appSecret}=client.credentials(env);
  const configured=Boolean(appKey&&appSecret);
  if(!configured){write({configured:false,error:'KIS 환경변수가 없습니다. 서비스와 같은 환경에서 실행하세요.'});return false;}
  const reader=createProgramReader({request:async(path,trId,params)=>{
    const token=await client.getAccessToken();
    if(!token)throw Object.assign(new Error('KIS 인증 미제공'),{kisCode:'AUTH_UNAVAILABLE'});
    const url=new URL(path,env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443');
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12_000);
    try{
      const response=await fetchImpl(url,{signal:controller.signal,headers:{authorization:`Bearer ${token}`,appkey:appKey,appsecret:appSecret,tr_id:trId,custtype:'P'}});
      const json=await response.json();
      if(!response.ok)throw Object.assign(new Error('KIS 요청 실패'),{kisCode:/^[A-Z0-9_]{1,32}$/.test(String(json.msg_cd))?json.msg_cd:`HTTP_${response.status}`});
      return json;
    }finally{clearTimeout(timer);}
  }});
  const out=await reader.summary(day,{date:clockDate,minutes:Number(clockParts.hour)*60+Number(clockParts.minute)});
  write({configured:true,requestedDate:day,programAsOfDate:out.asOfDate,unit:'억원',values:out.values,source:out.source,diagnostics:out.diagnostics,error:out.error});
  return out.values!==null;
}
if(require.main===module)main({targetDate:process.argv[2]}).then(ok=>{if(!ok)process.exitCode=1;}).catch(()=>{console.error('KIS 프로그램 진단 실패: 거래일·네트워크·인증 설정을 확인하세요.');process.exitCode=1;});
module.exports={main};
