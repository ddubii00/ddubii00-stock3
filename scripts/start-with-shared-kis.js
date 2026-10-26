'use strict';
// Linux/systemd launcher. Only the named running service's process environment
// is consulted; no .env, key/token file or persisted runtime data is opened.
const fs=require('node:fs'),path=require('node:path'),childProcess=require('node:child_process');
const {credentials}=require('../kis-market-data');
const KEY_NAMES=['KIS_APP_KEY','KIS_APPKEY','KIS_KEY','APP_KEY','APPKEY'];
const SECRET_NAMES=['KIS_APP_SECRET','KIS_APPSECRET','KIS_SECRET','APP_SECRET','APPSECRET'];
const NAMES=[...KEY_NAMES,...SECRET_NAMES,'KIS_BASE_URL'];
const complete=env=>{const pair=credentials(env);return Boolean(pair.appKey&&pair.appSecret);};
function serviceEnvironment(service,{execFileSync=childProcess.execFileSync,readFileSync=fs.readFileSync}={}){
  if(!/^[A-Za-z0-9_.@-]+\.service$/.test(service))throw new Error('SERVICE_NAME');
  const pid=String(execFileSync('systemctl',['show',service,'--property=MainPID','--value'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']})).trim();
  if(!/^[1-9]\d*$/.test(pid))throw new Error('SERVICE_NOT_RUNNING');
  const env={};
  for(const entry of readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')){
    const equals=entry.indexOf('='),name=entry.slice(0,equals);
    if(equals>0&&NAMES.includes(name))env[name]=entry.slice(equals+1);
  }
  return env;
}
function inheritKis(env,source){
  if(complete(env))return {env:{...env},inherited:false};
  if(!complete(source))throw new Error('SOURCE_NOT_CONFIGURED');
  const next={...env};
  // Import a complete pair together; never combine half of one app's pair
  // with half of another. Preserve the original variable names and all other
  // stock3 settings (especially PORT and its password/storage paths).
  for(const name of [...KEY_NAMES,...SECRET_NAMES])delete next[name];
  for(const name of [...KEY_NAMES,...SECRET_NAMES])if(source[name])next[name]=source[name];
  if(!next.KIS_BASE_URL&&source.KIS_BASE_URL)next.KIS_BASE_URL=source.KIS_BASE_URL;
  return {env:next,inherited:true};
}
function start({env=process.env,service=process.argv[2]||'webapp-stock5-8.service',readSource=serviceEnvironment,spawn=childProcess.spawn,log=console.log,warn=console.warn,onSignal=handler=>{process.on('SIGTERM',handler);process.on('SIGINT',handler);},exit=code=>process.exit(code)}={}){
  let launchEnv={...env};
  try{
    const result=inheritKis(env,complete(env)?{}:readSource(service));launchEnv=result.env;
    log(result.inherited?'[KIS 연결] 실행 중인 원본 서비스의 KIS 환경변수를 메모리로 전달했습니다.':'[KIS 연결] 기존 stock3 KIS 환경변수를 사용합니다.');
  }catch(_){warn('[KIS 연결] KIS 환경변수를 연결하지 못했습니다. 원본 서비스 실행 상태·환경변수·프로세스 접근 권한을 확인하세요. 앱은 계속 실행합니다.');}
  const child=spawn(process.execPath,[path.join(__dirname,'..','kis-flow-display.js')],{env:launchEnv,stdio:'inherit'});
  onSignal(()=>{try{child.kill('SIGTERM');}catch(_){}});
  child.on('error',()=>{warn('[KIS 연결] stock3 실행에 실패했습니다.');exit(1);});
  child.on('exit',(code,signal)=>exit(Number.isInteger(code)?code:signal==='SIGTERM'||signal==='SIGINT'?0:1));
  return child;
}
if(require.main===module)start();
module.exports={serviceEnvironment,inheritKis,start};
