'use strict';
const store=require('../shared-stock-store');
async function body(req) {
  if(req.body!==undefined) {
    const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body);
    if(Buffer.byteLength(raw)>16_384)throw Object.assign(new Error('요청이 너무 큽니다.'),{status:413});
    try{return JSON.parse(raw);}catch(_){throw Object.assign(new Error('종목 변경 요청을 확인하세요.'),{status:400});}
  }
  let raw='';
  for await(const chunk of req) {
    raw+=chunk;
    if(Buffer.byteLength(raw)>16_384)throw Object.assign(new Error('요청이 너무 큽니다.'),{status:413});
  }
  try{return JSON.parse(raw);}catch(_){throw Object.assign(new Error('종목 변경 요청을 확인하세요.'),{status:400});}
}
module.exports=async function handler(req,res) {
  if(!require('../access-control').requireAccess(req,res))return;
  res.setHeader('Cache-Control','no-store');
  if(!['GET','POST'].includes(req.method)) {res.setHeader('Allow','GET, POST');return res.status(405).json({ok:false,error:'지원하지 않는 요청입니다.'});}
  try {
    const state=req.method==='GET'?await store.read():await store.update(await body(req));
    return res.status(200).json({ok:true,...state});
  } catch(error) {return res.status(error.status || 503).json({ok:false,error:error.status?error.message:'공유 종목 목록을 불러오지 못했습니다.'});}
};
