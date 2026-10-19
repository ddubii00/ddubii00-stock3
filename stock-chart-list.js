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
      if(!picker.valid(item)||!/^[A-Z][A-Z0-9_]{0,48}$/.test(item.slot)||keys.has(item.key)||slots.has(item.slot)) return false;
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
      let slot=DEFAULTS.find(item=>item.key===action.stock.key)?.slot || `STOCK_${action.stock.code}_${action.stock.market}`;
      if(rows.some(item=>item.slot===slot))slot=`STOCK_${action.stock.code}_${action.stock.market}`;
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
  function create({urlFor,onMount,onRemove,onChange=()=>{}}){
    const doc=browser.document,dialog=doc.getElementById('chartStocksDialog'),list=doc.getElementById('chartStocksList');
    const message=doc.getElementById('chartStocksMessage'),addArea=doc.getElementById('chartStocksAddArea');
    const originals=new Map(DEFAULTS.map(item=>[item.slot,doc.getElementById(`lwchart-${item.slot}`).closest('section')]));
    const template=originals.get('SAMSUNG_DAILY').cloneNode(true);
    const container=doc.createElement('div');container.id='selectedStockCharts';container.style.display='contents';
    const anchor=doc.getElementById('lwchart-USDJPY_DAILY').closest('section');anchor.after(container);
    let storage;try{storage=browser.localStorage;}catch(_){/* optional */}
    const storageKey=`stock3-chart-list:v1:${browser.location.pathname.replace(/\/index\.html$/,'').replace(/\/$/,'')}`;
    let items=read(storage,storageKey,(slot,initial)=>picker.readSelection(slot,initial,storage));
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
      for(const [slot,card] of mounted)if(!items.some(item=>item.slot===slot)){onRemove(slot);card.remove();mounted.delete(slot);}
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
    function apply(action){
      const next=change(items,action);
      if(JSON.stringify(next)===JSON.stringify(items))return false;
      items=next;message.textContent='';
      try{storage?.setItem(storageKey,JSON.stringify(items));}catch(_){message.textContent='이 브라우저에서는 종목 목록을 저장하지 못합니다.';browser.console?.warn('종목 차트 목록 저장 실패');}
      render();onChange(items);return true;
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
      canSelect:stock=>!items.some(item=>item.key===stock.key),onSelect:stock=>{if(apply({type:'add',stock}))addArea.hidden=true;}});
    render();
    return {current:()=>items.map(item=>({...item})),replace:(slot,stock)=>apply({type:'replace',slot,stock}),canReplace:(slot,stock)=>!items.some(item=>item.slot!==slot&&item.key===stock.key)};
  }
  return {DEFAULTS,clean,read,change,create};
});
