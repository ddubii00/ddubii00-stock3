'use strict';
const path=require('node:path');
const selection=require('./dashboard-selection');
const invalid=()=>Object.assign(new Error('서로 다른 차트·대시보드를 최대 4개 선택하세요.'),{status:400});
function decode(raw){
  if(raw==null)return {revision:0,initialized:false,slots:selection.empty()};
  const state=JSON.parse(raw);
  if(!Number.isSafeInteger(state.revision)||state.revision<1||!selection.validSlots(state.slots))throw new Error('선택 목록 저장소 형식 오류');
  return {revision:state.revision,initialized:true,slots:state.slots};
}
function validate(action){if(!action||!selection.validSlots(action.slots))throw invalid();}
function nextState(current,action){
  if(current.initialized&&JSON.stringify(current.slots)===JSON.stringify(action.slots))return current;
  return {revision:current.revision+1,initialized:true,slots:action.slots.slice()};
}
function createStore(options={}){
  const env=options.env||process.env;
  const folder=path.dirname(env.STOCK3_STOCK_LIST_PATH||path.join(__dirname,'.stock3-data','chart-stocks.json'));
  return require('./shared-stock-store').createStore({...options,env,
    filename:env.STOCK3_DASHBOARD_SELECTION_PATH||path.join(folder,'dashboard-selection.json'),
    storeKey:'stock3:dashboard-selection:v1',decodeState:decode,validateAction:validate,applyAction:nextState,
    warn:options.warn||(()=>console.warn('공유 화면 선택 저장소 접근 실패'))});
}
module.exports={createStore,decode,validate,...createStore()};
