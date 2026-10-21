'use strict';
const store=require('../shared-dashboard-selection');
async function body(req){
  let raw='';
  if(req.body!==undefined)raw=typeof req.body==='string'?req.body:JSON.stringify(req.body);
  else for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw Object.assign(new Error('요청이 너무 큽니다.'),{status:413});}
  if(Buffer.byteLength(raw)>4096)throw Object.assign(new Error('요청이 너무 큽니다.'),{status:413});
  try{return JSON.parse(raw);}catch(_){throw Object.assign(new Error('선택 목록 요청을 확인하세요.'),{status:400});}
}
module.exports=async function handler(req,res){
  if(!require('../access-control').requireAccess(req,res))return;
  res.setHeader('Cache-Control','no-store');
  if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({ok:false,error:'지원하지 않는 요청입니다.'});}
  try{
    const state=req.method==='GET'?await store.read():await store.update(await body(req));
    return res.status(200).json({ok:true,...state});
  }catch(error){
    return res.status(error.status||503).json({ok:false,error:error.status&&error.status!==503?error.message:'공유 선택 목록을 확인하지 못했습니다. 서버 저장 권한 또는 공유 저장소 설정을 확인하세요.'});
  }
};
