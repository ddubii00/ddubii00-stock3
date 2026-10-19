(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./stock-chart-picker'));
  else root.StockChartList=factory(root.StockChartPicker,root);
})(typeof globalThis!=='undefined'?globalThis:this,function(picker,browser){
  'use strict';
  const DEFAULTS=[{slot:'SAMSUNG_DAILY',name:'삼성전자',code:'005930',market:'KOSPI',key:'KR:005930:KOSPI'},
    {slot:'SKHYNIX_DAILY',name:'SK하이닉스',code:'000660',market:'KOSPI',key:'KR:000660:KOSPI'}];
  function clean(rows){
    const keys=new Set(),slots=new Set();
    return (Array.isArray(rows)?rows:[]).filter(item=>{
      if(!picker.valid(item)||!(DEFAULTS.some(row=>row.slot===item.slot)||/^STOCK_[A-Z0-9_]{1,43}$/.test(item.slot))||keys.has(item.key)||slots.has(item.slot)) return false;
      keys.add(item.key);slots.add(item.slot);return true;
    }).slice(0,20).map(({slot,name,code,market,key})=>({slot,name,code,market,key}));
  }
  function read(storage,key,legacy=(slot,initial)=>initial){
    try {const saved=JSON.parse(storage?.getItem(key)||'null');if(Array.isArray(saved))return clean(saved);}catch(_){/* storage is optional */}
    return clean(DEFAULTS.map(item=>({...legacy(item.slot,item),slot:item.slot})));
  }
  function change(items,action){
    const rows=clean(items);
    if(action.type==='add'&&picker.valid(action.stock)&&rows.length<20&&!rows.some(item=>item.key===action.stock.key)){
      let slot=DEFAULTS.find(item=>item.key===action.stock.key)?.slot || `STOCK_${action.stock.code.replace(/[^A-Z0-9]/g,'_')}_${action.stock.market}`;
      if(rows.some(item=>item.slot===slot))slot=`STOCK_${action.stock.code.replace(/[^A-Z0-9]/g,'_')}_${action.stock.market}`;
      const base=slot;let suffix=2;
      while(rows.some(item=>item.slot===slot))slot=`${base}_${suffix++}`;
      rows.push({...action.stock,slot});
    }
    if(action.type==='remove')return rows.filter(item=>item.slot!==action.slot);
    if(action.type==='replace'&&picker.valid(action.stock)&&!rows.some(item=>item.slot!==action.slot&&item.key===action.stock.key))return rows.map(item=>item.slot===action.slot?{...action.stock,slot:item.slot}:item);
    if(action.type==='move'){
      const index=rows.findIndex(item=>item.slot===action.slot),next=index+action.direction;
      if(index>=0&&next>=0&&next<rows.length)[rows[index],rows[next]]=[rows[next],rows[index]];
    }
    return clean(rows);
  }
  function sharedClient({fetchImpl,urlFor,onState,onError}){
    let queue=Promise.resolve(),revision=-1;
    const request=(action)=>{
      const task=queue.then(async()=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
        try{
          const response=await fetchImpl(urlFor('/api/chart-stocks'),{cache:'no-store',signal:controller.signal,...(action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)}:{})});
          const json=await response.json();
          if(!response.ok||!json.ok)throw new Error(json.error || '공유 목록을 확인하지 못했습니다.');
          if(!Number.isSafeInteger(json.revision)||!Array.isArray(json.items)||JSON.stringify(clean(json.items))!==JSON.stringify(json.items))throw new Error('공유 목록 응답을 확인하지 못했습니다.');
          if(json.revision>=revision){revision=json.revision;onState(json);}
          return json;
        }finally{clearTimeout(timer);}
      });
      queue=task.catch(error=>{onError(error);});
      return task;
    };
    return {load:()=>request(),apply:action=>request(action)};
  }
  async function create({urlFor,onMount,onRemove,onChange=()=>{}}){
    const doc=browser.document,dialog=doc.getElementById('chartStocksDialog'),list=doc.getElementById('chartStocksList');
    const message=doc.getElementById('chartStocksMessage'),addArea=doc.getElementById('chartStocksAddArea');
    const originals=new Map(DEFAULTS.map(item=>[item.slot,doc.getElementById(`lwchart-${item.slot}`).closest('section')]));
    const template=originals.get('SAMSUNG_DAILY').cloneNode(true);
    const container=doc.createElement('div');container.id='selectedStockCharts';container.style.display='contents';
    const anchor=doc.getElementById('lwchart-SP500').closest('.card');anchor.after(container);
    let storage;try{storage=browser.localStorage;}catch(_){/* optional */}
    const storageKey=`stock3-chart-list:v1:${browser.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'')}`;
    const seed=read(storage,storageKey,(slot,initial)=>picker.readSelection(slot,initial,storage));
    let items=[],ready=false,polling=false,rendered=false;
    const mounted=new Map();
    const button=(text,label,action,slot,disabled=false)=>{
      const node=doc.createElement('button');node.type='button';node.className='btn outline';node.textContent=text;node.setAttribute('aria-label',label);node.dataset.action=action;node.dataset.slot=slot;node.disabled=disabled;return node;
    };
    function cardFor(item){
      const original=originals.has(item.slot);
      const card=originals.get(item.slot)||template.cloneNode(true);
      originals.delete(item.slot);
      if(!original)for(const node of [card,...card.querySelectorAll('*')])for(const attribute of [...node.attributes])if(attribute.value.includes('SAMSUNG_DAILY'))node.setAttribute(attribute.name,attribute.value.replaceAll('SAMSUNG_DAILY',item.slot));
      card.dataset.chartSlot=item.slot;card.dataset.stockKey=item.key;return card;
    }
    function render(){
      for(const [slot,card] of mounted)if(!items.some(item=>item.slot===slot&&item.key===card.dataset.stockKey)){onRemove(slot);card.remove();mounted.delete(slot);}
      for(const [slot,card] of originals)if(!mounted.has(slot)&&!items.some(item=>item.slot===slot))card.remove();
      container.querySelector('.stock-charts-empty')?.remove();
      list.replaceChildren();
      items.forEach((item,index)=>{
        let card=mounted.get(item.slot);
        if(!card){card=cardFor(item);container.appendChild(card);mounted.set(item.slot,card);onMount(item,card);}
        else container.appendChild(card);
        card.dataset.stockKey=item.key;
        const row=doc.createElement('div');row.className='chart-stock-row';
        const name=doc.createElement('span');name.textContent=`${index+1}. ${item.name}`;row.appendChild(name);
        row.appendChild(button('↑',`${item.name} 위로`,'move-up',item.slot,index===0));
        row.appendChild(button('↓',`${item.name} 아래로`,'move-down',item.slot,index===items.length-1));
        row.appendChild(button('×',`${item.name} 삭제`,'remove',item.slot));list.appendChild(row);
      });
      if(!items.length){const empty=doc.createElement('section');empty.className='card span-12 stock-charts-empty';empty.textContent='헤더의 종목 버튼에서 차트를 추가하세요.';container.appendChild(empty);}
    }
    const client=sharedClient({fetchImpl:(...args)=>browser.fetch(...args),urlFor,
      onState(state){
        ready=state.initialized;message.textContent=ready?'다른 컴퓨터와 공유 중 · 20초마다 동기화':'기존 종목 목록을 서버로 옮기는 중…';
        if(!rendered || JSON.stringify(items)!==JSON.stringify(state.items)){
          rendered=true;
          items=clean(state.items);render();onChange(items);
          try{storage?.setItem(storageKey,JSON.stringify(items));}catch(_){/* server remains authoritative */}
        }
      },
      onError(error){message.textContent=`${error.message} · 변경은 저장되지 않았습니다.`;}
    });
    async function apply(action){
      if(!ready){message.textContent='공유 저장소 연결을 확인한 후 다시 시도하세요.';return false;}
      try{await client.apply(action);return true;}catch(_){return false;}
    }
    async function sync(){
      if(polling||doc.hidden)return;
      polling=true;
      try{
        const state=await client.load();
        if(!state.initialized)await client.apply({type:'init',items:seed});
      }catch(_){/* keep the last confirmed list */}finally{polling=false;}
    }
    doc.getElementById('openChartStocks').addEventListener('click',()=>dialog.showModal());
    doc.getElementById('closeChartStocks').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
    list.addEventListener('click',event=>{
      const target=event.target.closest('button[data-action]');if(!target)return;
      if(target.dataset.action==='remove')apply({type:'remove',slot:target.dataset.slot});
      else apply({type:'move',slot:target.dataset.slot,direction:target.dataset.action==='move-up'?-1:1});
    });
    doc.getElementById('addChartStock').addEventListener('click',()=>{
      if(items.length>=20){message.textContent='종목 차트는 최대 20개까지 표시합니다.';return;}
      addArea.hidden=false;const input=doc.getElementById('stock-search-CHART_ADD');input.value='';input.focus();
    });
    picker.attach({slot:'CHART_ADD',selectionLabel:'추가할 종목 검색',initial:{name:'',code:'',market:'',key:''},urlFor,
      canSelect:stock=>!items.some(item=>item.key===stock.key),onSelect:async stock=>{if(await apply({type:'add',stock}))addArea.hidden=true;}});
    await sync();
    if(!ready){items=clean(DEFAULTS);render();}
    browser.setInterval(()=>{void sync();},20_000);
    doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)void sync();});
    return {sync,current:()=>items.map(item=>({...item})),canReplace:(slot,stock)=>!items.some(item=>item.slot!==slot&&item.key===stock.key)};
  }
  return {DEFAULTS,clean,read,change,sharedClient,create};
});
