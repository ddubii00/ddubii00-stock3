(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.DashboardSelection=factory(root);
})(typeof globalThis!=='undefined'?globalThis:this,function(browser){
  'use strict';
  const COUNT=4;
  const empty=()=>Array(COUNT).fill(null);
  const validId=id=>typeof id==='string' && (/^panel:[A-Za-z][A-Za-z0-9_-]{0,90}$/.test(id) || /^stock:(?:KR:\d{6}:(?:KOSPI|KOSDAQ)|US:[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?:(?:NASDAQ|NYSE|AMEX))$/.test(id));
  function validSlots(slots){
    return Array.isArray(slots)&&slots.length===COUNT&&slots.every(id=>id===null||validId(id))&&new Set(slots.filter(Boolean)).size===slots.filter(Boolean).length;
  }
  function createClient({fetchImpl,urlFor,onState=()=>{}}){
    let revision=-1,queue=Promise.resolve();
    function request(slots){
      const task=queue.then(async()=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
        try{
          const response=await fetchImpl(urlFor('/api/dashboard-selection'),{cache:'no-store',signal:controller.signal,...(slots?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slots})}:{})});
          const state=await response.json();
          if(!response.ok||!state.ok)throw new Error(state.error||'선택 목록을 서버에서 확인하지 못했습니다.');
          if(!Number.isSafeInteger(state.revision)||state.revision<0||!validSlots(state.slots))throw new Error('선택 목록 응답을 확인하지 못했습니다.');
          if(state.revision>=revision){revision=state.revision;onState(state);}
          return state;
        }finally{clearTimeout(timer);}
      });
      queue=task.catch(()=>{});return task;
    }
    return {load:()=>request(),save:slots=>validSlots(slots)?request(slots):Promise.reject(new Error('서로 다른 항목을 최대 4개 선택하세요.'))};
  }
  function catalog(doc){
    const entries=[],seen=new Set();
    for(const card of doc.querySelectorAll('.wrap .card')){
      if(card.parentElement?.closest('.card'))continue;
      const titleNode=card.querySelector('.stock-chart-name')||card.querySelector('.title');
      if(!titleNode)continue;
      const anchor=card.querySelector('.chart[id]')||card.querySelector('[id]');
      const id=card.dataset.stockKey?`stock:${card.dataset.stockKey}`:anchor?`panel:${anchor.id}`:'';
      if(!validId(id)||seen.has(id))continue;
      seen.add(id);entries.push({id,title:titleNode.textContent.trim().replace(/\s+/g,' '),node:card});
    }
    return entries;
  }
  function create({urlFor}){
    const doc=browser.document,dialog=doc.getElementById('dashboardSelectionDialog');
    const message=doc.getElementById('dashboardSelectionMessage'),saveButton=doc.getElementById('saveDashboardSelection');
    const compact=doc.getElementById('compactDashboard'),rows=doc.getElementById('dashboardSelectionRows');
    const allButton=doc.getElementById('showAllPanels'),partialButton=doc.getElementById('showSelectedPanels');
    let slots=empty(),draft=empty(),entries=[],portals=[],mode='all',ready=false,dirty=false,editing=false,saving=false,polling=false;
    const controls=[];
    function restore(){
      for(const {node,marker} of portals){
        if(marker.parentNode&&node.isConnected)marker.replaceWith(node);
        else marker.remove();
      }
      portals=[];compact.replaceChildren();
    }
    function paint(){
      restore();entries=catalog(doc);
      doc.body.dataset.dashboardMode=mode;
      allButton.setAttribute('aria-pressed',String(mode==='all'));
      partialButton.setAttribute('aria-pressed',String(mode==='partial'));
      compact.hidden=mode!=='partial';
      if(mode!=='partial')return;
      slots.forEach(id=>{
        const entry=entries.find(item=>item.id===id);
        if(entry){
          const marker=doc.createComment('dashboard-selection-position');
          entry.node.before(marker);portals.push({node:entry.node,marker});compact.appendChild(entry.node);
        }else{
          const cell=doc.createElement('section');cell.className='card compact-panel-empty';
          cell.textContent=id?'선택한 항목이 삭제되었습니다. ‘선택’에서 다시 지정하세요.':'‘선택’에서 표시할 차트·대시보드를 지정하세요.';
          compact.appendChild(cell);
        }
      });
    }
    function options(){
      controls.forEach(({select,clear},index)=>{
        select.replaceChildren();
        const blank=doc.createElement('option');blank.value='';blank.textContent='선택 안 함';select.appendChild(blank);
        for(const entry of entries){
          const option=doc.createElement('option');option.value=entry.id;option.textContent=entry.title;
          option.disabled=draft.some((id,i)=>i!==index&&id===entry.id);select.appendChild(option);
        }
        if(draft[index]&&!entries.some(entry=>entry.id===draft[index])){
          const missing=doc.createElement('option');missing.value=draft[index];missing.textContent='삭제되었거나 표시할 수 없는 항목';select.appendChild(missing);
        }
        select.value=draft[index]||'';clear.disabled=!draft[index];
      });
    }
    const client=createClient({fetchImpl:(...args)=>browser.fetch(...args),urlFor,onState:state=>{
      const changed=JSON.stringify(slots)!==JSON.stringify(state.slots);
      slots=state.slots.slice();ready=true;saveButton.disabled=saving;
      if(changed)paint();
      if(!dirty){draft=slots.slice();options();}
    }});
    async function sync(){
      if(polling||doc.hidden)return;
      polling=true;
      try{await client.load();}
      catch(error){if(editing)message.textContent=`${error.message} · 서버 연결 후 다시 시도하세요.`;}
      finally{polling=false;}
    }
    function setMode(next){mode=next;paint();}
    for(let index=0;index<COUNT;index++){
      const row=doc.createElement('div');row.className='dashboard-selection-row';
      const label=doc.createElement('label');label.textContent=`${index+1}번`;
      const select=doc.createElement('select');select.id=`dashboard-selection-${index}`;label.htmlFor=select.id;
      const clear=doc.createElement('button');clear.type='button';clear.className='btn outline';clear.textContent='×';clear.setAttribute('aria-label',`${index+1}번 선택 삭제`);
      const changed=()=>{dirty=true;options();message.textContent='저장을 누르면 다른 컴퓨터에도 반영됩니다.';};
      select.addEventListener('change',()=>{draft[index]=select.value||null;changed();});
      clear.addEventListener('click',()=>{draft[index]=null;changed();});
      row.append(label,select,clear);rows.appendChild(row);controls.push({select,clear});
    }
    doc.getElementById('openDashboardSelection').addEventListener('click',()=>{
      paint();editing=true;dirty=false;draft=slots.slice();options();message.textContent=ready?'최대 4개 · 저장한 선택은 다른 컴퓨터와 공유됩니다.':'서버의 선택 목록을 확인하는 중입니다.';
      saveButton.disabled=!ready;dialog.showModal();void sync();
    });
    doc.getElementById('closeDashboardSelection').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{editing=false;dirty=false;draft=slots.slice();});
    dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
    saveButton.addEventListener('click',async()=>{
      if(saving||!ready)return;
      if(draft.some(id=>id&&!entries.some(entry=>entry.id===id))){message.textContent='삭제된 항목은 ×로 비우거나 다른 항목을 선택하세요.';return;}
      saving=true;saveButton.disabled=true;
      try{await client.save(draft.slice());dirty=false;draft=slots.slice();options();message.textContent='서버에 저장했습니다. ‘일부’를 누르면 선택 항목만 표시합니다.';}
      catch(error){message.textContent=`${error.message} · 변경은 저장되지 않았습니다.`;}
      finally{saving=false;saveButton.disabled=false;}
    });
    allButton.addEventListener('click',()=>setMode('all'));
    partialButton.addEventListener('click',()=>{setMode('partial');void sync();});
    paint();void sync();
    browser.setInterval(()=>{void sync();},20_000);
    doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)void sync();});
    return {restore,catalogChanged:()=>{paint();options();},setMode};
  }
  return {COUNT,empty,validId,validSlots,createClient,catalog,create};
});
