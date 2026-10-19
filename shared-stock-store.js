'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const list = require('./stock-chart-list');

const STORE_KEY = 'stock3:chart-stocks:v1';
const unavailable = () => Object.assign(new Error('공유 종목 저장소를 확인하세요. 서버의 저장 권한 또는 공유 저장소 설정이 필요합니다.'), {status:503});
const invalid = () => Object.assign(new Error('종목 변경 요청을 확인하세요.'), {status:400});
function decode(raw) {
  if (raw == null) return {revision:0,initialized:false,items:list.clean(list.DEFAULTS)};
  const value=JSON.parse(raw);
  if (!Number.isSafeInteger(value.revision) || value.revision<1 || !Array.isArray(value.items) || JSON.stringify(list.clean(value.items))!==JSON.stringify(value.items)) throw unavailable();
  return {...value,initialized:true};
}
function validate(action) {
  if (!action || typeof action!=='object') throw invalid();
  if (action.type==='init') {
    if (!Array.isArray(action.items) || JSON.stringify(list.clean(action.items))!==JSON.stringify(action.items)) throw invalid();
  } else if (action.type==='add') {
    if (!require('./stock-chart-picker').valid(action.stock)) throw invalid();
  } else if (!['remove','move'].includes(action.type) || typeof action.slot!=='string' || !/^[A-Z][A-Z0-9_]{0,48}$/.test(action.slot) || (action.type==='move' && ![-1,1].includes(action.direction))) throw invalid();
}
function nextState(current,action) {
  if (action.type==='init' && current.initialized) return current;
  const items=action.type==='init'?list.clean(action.items):list.change(current.items,action);
  if(current.initialized && JSON.stringify(items)===JSON.stringify(current.items)) return current;
  return {revision:current.revision+1,initialized:true,items};
}
function createStore({env=process.env,io=fs,fetchImpl=(...args)=>fetch(...args),warn=()=>console.warn('공유 종목 목록 저장소 접근 실패')}={}) {
  const filename=env.STOCK3_STOCK_LIST_PATH || path.join(__dirname,'.stock3-data','chart-stocks.json');
  // Oracle persists on disk. Read-only/serverless deployments must use shared Redis REST,
  // never a temporary directory or a process-local list that disappears on a cold start.
  const restUrl=env.STOCK3_LIST_REST_URL || env.KV_REST_API_URL;
  const restToken=env.STOCK3_LIST_REST_TOKEN || env.KV_REST_API_TOKEN;
  const remote=Boolean(restUrl && restToken);
  async function redis(command) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
    try {
      const response=await fetchImpl(restUrl,{method:'POST',headers:{authorization:`Bearer ${restToken}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:controller.signal});
      const json=await response.json();
      if (!response.ok || json.error) throw unavailable();
      return json.result;
    } finally {clearTimeout(timer);}
  }
  async function rawRead() {
    if(remote) return redis(['GET',STORE_KEY]);
    if(env.VERCEL) throw unavailable();
    try {return await io.readFile(filename,'utf8');}
    catch(error) {if(error.code==='ENOENT')return null;throw error;}
  }
  async function read() {
    try {return decode(await rawRead());}
    catch(_) {warn();throw unavailable();}
  }
  async function update(action) {
    validate(action);
    if(remote) {
      try {
        // Compare-and-set prevents two browsers/serverless instances losing each other's edits.
        for(let attempt=0;attempt<8;attempt++) {
          const old=await rawRead(),current=decode(old),next=nextState(current,action);
          if(next===current)return current;
          const success=await redis(['EVAL',"local v=redis.call('GET',KEYS[1]); if (v or '')==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 else return 0 end",1,STORE_KEY,old || '',JSON.stringify(next)]);
          if(Number(success)===1)return next;
        }
        throw unavailable();
      } catch(_) {warn();throw unavailable();}
    }
    if(env.VERCEL) {warn();throw unavailable();}
    let lock,temp;
    const lockPath=`${filename}.lock`;
    try {
      await io.mkdir(path.dirname(filename),{recursive:true});
      // A lock also protects overlapping Node workers. Never remove another worker's lock.
      for(let attempt=0;attempt<40;attempt++) {
        try {lock=await io.open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid}));break;}
        catch(error) {
          if(error.code!=='EEXIST')throw error;
          // An interrupted worker may leave a lock. Reclaim it only when its owner
          // no longer exists, or an empty lock has remained untouched for a minute.
          try {
            const info=await io.stat(lockPath),raw=await io.readFile(lockPath,'utf8');
            let owner;try{owner=JSON.parse(raw).pid;}catch(_){/* interrupted before writing the owner */}
            let dead=false;
            if(Number.isInteger(owner)&&owner>0)try{process.kill(owner,0);}catch(check){dead=check.code==='ESRCH';}
            if(dead || (!owner && Date.now()-info.mtimeMs>60_000)){
              const current=await io.stat(lockPath);
              if(current.ino===info.ino)await io.unlink(lockPath);
            }
          }catch(check){if(check.code!=='ENOENT')throw check;}
          await new Promise(resolve=>setTimeout(resolve,50));
        }
      }
      if(!lock)throw unavailable();
      const current=decode(await rawRead()),next=nextState(current,action);
      if(next===current)return current;
      temp=`${filename}.${randomUUID()}.tmp`;
      await io.writeFile(temp,JSON.stringify(next),'utf8');
      await io.rename(temp,filename);temp=null;
      return next;
    } catch(_) {warn();throw unavailable();}
    finally {
      if(temp)try{await io.unlink(temp);}catch(_){warn();}
      if(lock) {
        try{await lock.close();}catch(_){warn();}
        try{await io.unlink(lockPath);}catch(_){warn();}
      }
    }
  }
  return {read,update};
}
module.exports={createStore,validate,decode,...createStore()};
