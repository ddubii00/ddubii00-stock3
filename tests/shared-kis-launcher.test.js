'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {serviceEnvironment,inheritKis,start}=require('../scripts/start-with-shared-kis');
test('only KIS environment variables are obtained from a validated live service PID',()=>{
  const reads=[];
  const env=serviceEnvironment('webapp-stock5-8.service',{
    execFileSync:(cmd,args)=>{assert.equal(cmd,'systemctl');assert.deepEqual(args,['show','webapp-stock5-8.service','--property=MainPID','--value']);return '123\n';},
    readFileSync:file=>{reads.push(file);return 'KIS_APPKEY=TEST_ONLY_KEY\0KIS_APPSECRET=TEST_ONLY_SECRET\0PORT=9999\0STOCK5_PASSWORD=DO_NOT_COPY\0KIS_ACCESS_TOKEN=DO_NOT_COPY\0';}
  });
  assert.deepEqual(reads,['/proc/123/environ']);assert.deepEqual(Object.keys(env).sort(),['KIS_APPKEY','KIS_APPSECRET']);
  assert.throws(()=>serviceEnvironment('../bad.service'),/SERVICE_NAME/);
  assert.throws(()=>serviceEnvironment('app.service',{execFileSync:()=> '0'}),/SERVICE_NOT_RUNNING/);
});
test('inheritance keeps stock3 port/password/storage and uses a complete pair without renaming aliases',()=>{
  const current={PORT:'8004',STOCK3_PASSWORD:'TEST_ONLY_PASSWORD',STOCK3_STOCK_LIST_PATH:'/var/lib/stock3/stocks.json',KIS_APP_KEY:'OLD_INCOMPLETE'};
  const source={KIS_APPKEY:'TEST_ONLY_KEY',KIS_APPSECRET:'TEST_ONLY_SECRET',PORT:'9999',STOCK3_PASSWORD:'DO_NOT_COPY',KIS_BASE_URL:'https://example.invalid'};
  const result=inheritKis(current,source);
  assert.equal(result.inherited,true);assert.equal(result.env.PORT,'8004');assert.equal(result.env.STOCK3_PASSWORD,current.STOCK3_PASSWORD);
  assert.equal(result.env.STOCK3_STOCK_LIST_PATH,current.STOCK3_STOCK_LIST_PATH);assert.equal(result.env.KIS_APP_KEY,undefined);
  assert.equal(result.env.KIS_APPKEY,source.KIS_APPKEY);assert.equal(result.env.KIS_APPSECRET,source.KIS_APPSECRET);assert.equal(current.KIS_APP_KEY,'OLD_INCOMPLETE');
  assert.throws(()=>inheritKis(current,{KIS_APPSECRET:'TEST_ONLY_SECRET'}),/SOURCE_NOT_CONFIGURED/);
});
function fixture(env,readSource){
  const logs=[],events={},launches=[],signals=[];
  const child={on:(event,handler)=>{events[event]=handler;},kill:signal=>signals.push(signal)};
  start({env,readSource,log:line=>logs.push(line),warn:line=>logs.push(line),onSignal:handler=>{events.signal=handler;},exit:code=>logs.push({exit:code}),spawn:(exe,args,options)=>{launches.push({exe,args,options});return child;}});
  return {logs,events,launches,signals};
}
test('an existing complete stock3 pair skips peer access, and launcher forwards shutdown and exit',()=>{
  const f=fixture({KIS_KEY:'TEST_ONLY_KEY',KIS_SECRET:'TEST_ONLY_SECRET'},()=>{throw new Error('Must not inspect peer');});
  assert.equal(f.launches.length,1);assert.match(f.launches[0].args[0],/kis-flow-display\.js$/);assert.equal(f.launches[0].options.env.KIS_KEY,'TEST_ONLY_KEY');
  f.events.signal();assert.deepEqual(f.signals,['SIGTERM']);f.events.exit(0);assert.deepEqual(f.logs.at(-1),{exit:0});
  assert.doesNotMatch(JSON.stringify(f.logs),/TEST_ONLY_KEY|TEST_ONLY_SECRET/);
});
test('peer read failures leave the app running and neither errors nor credentials reach logs',()=>{
  const f=fixture({PORT:'8004'},()=>{throw new Error('DO_NOT_LOG_PRIVATE_TEXT');});
  assert.equal(f.launches.length,1);assert.equal(f.launches[0].options.env.PORT,'8004');
  assert.doesNotMatch(JSON.stringify(f.logs),/PRIVATE_TEXT/);assert.match(f.logs[0],/앱은 계속 실행/);
  const inherited=fixture({PORT:'8004'},()=>({KIS_APP_KEY:'TEST_ONLY_KEY',KIS_APP_SECRET:'TEST_ONLY_SECRET'}));
  assert.equal(inherited.launches[0].options.env.KIS_APP_KEY,'TEST_ONLY_KEY');assert.doesNotMatch(JSON.stringify(inherited.logs),/TEST_ONLY_KEY|TEST_ONLY_SECRET/);
});
