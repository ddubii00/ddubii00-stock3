(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.TradingViewCard=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SYMBOL='WHSELFINVEST:USTECH100CFD';
  const INTERVAL='3';
  const layouts=new WeakMap();
  function refreshLayout(doc){layouts.get(doc)?.schedule();}
  function mountAfterStocks(doc){
    const anchor=doc.getElementById('selectedStockCharts');
    if(!anchor)return null;
    const existing=doc.getElementById('tradingview-USTECH100');
    if(existing)return existing;
    const card=doc.createElement('section');
    card.id='tradingview-USTECH100';card.className='card span-6 technical-card tradingview-card';
    card.setAttribute('data-dashboard-id','panel:tvchart-USTECH100');
    card.setAttribute('data-dashboard-title','USTECH100 (나스닥100 CFD)');
    // Moving an iframe's ancestor with appendChild tears down its browsing
    // context. Move only this empty layout slot; keep the live card attached
    // to body for its entire lifetime, in both full and partial views.
    const slot=doc.createElement('section');slot.id='tradingview-USTECH100-slot';
    slot.className='card span-6 technical-card tradingview-slot';
    slot.setAttribute('data-dashboard-id','panel:tvchart-USTECH100');
    slot.setAttribute('data-dashboard-title','USTECH100 (나스닥100 CFD)');
    slot.setAttribute('aria-hidden','true');
    card.className+=' tradingview-floating';
    card.style.visibility='hidden';
    // Keep the app-sized frame separate from the container the external loader may resize.
    const frame=doc.createElement('div');frame.id='tvchart-USTECH100';
    frame.className='chart reference-chart';
    frame.setAttribute('aria-label','USTECH100 TradingView 차트');
    const body=doc.createElement('div');body.className='tradingview-widget-container';
    frame.append(body);
    const widget=doc.createElement('div');widget.className='tradingview-widget-container__widget';
    const footer=doc.createElement('div');footer.className='tradingview-widget-copyright';
    const link=doc.createElement('a');
    link.href=`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`;
    link.target='_blank';link.rel='noopener nofollow';link.textContent='USTECH100 차트 · TradingView';
    footer.append(link);
    const status=doc.createElement('div');status.className='tradingview-error';status.setAttribute('role','status');status.hidden=true;
    frame.append(status);card.append(frame);
    // The official iframe owns its live feed. Do not read its prices or recreate it on the app's 20-second poll.
    function load(){
      widget.replaceChildren();body.replaceChildren(widget,footer);
      const script=doc.createElement('script');script.type='text/javascript';script.async=true;
      script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.textContent=JSON.stringify({autosize:true,symbol:SYMBOL,interval:INTERVAL,
        timezone:'Asia/Seoul',theme:'light',style:'1',locale:'kr',
        allow_symbol_change:false,hide_side_toolbar:false,hide_top_toolbar:false,
        hide_legend:true,save_image:false,calendar:false,studies:[]});
      script.onerror=()=>{if(script.isConnected){status.hidden=false;status.textContent='위젯 연결 실패 · 화면을 새로고침해주세요.';}};
      body.append(script);
    }
    anchor.after(slot);doc.body.append(card);
    const win=doc.defaultView;
    let queued=false;
    function position(){
      const rect=slot.getBoundingClientRect();
      const visible=slot.isConnected&&rect.width>0&&rect.height>0;
      card.style.visibility=visible?'visible':'hidden';
      card.style.pointerEvents=visible?'auto':'none';
      // Leave hidden frames at their last size so hiding another panel or
      // opening the access gate does not resize the widget to zero.
      if(!visible)return;
      for(const [key,value] of Object.entries({left:rect.left,top:rect.top,width:rect.width,height:rect.height})){
        const size=`${value}px`;if(card.style[key]!==size)card.style[key]=size;
      }
    }
    function schedule(){
      if(queued)return;
      if(!win?.requestAnimationFrame){position();return;}
      queued=true;win.requestAnimationFrame(()=>{queued=false;position();});
    }
    if(win?.ResizeObserver){
      const observer=new win.ResizeObserver(schedule);
      for(const node of [slot,slot.parentElement,doc.querySelector?.('.wrap'),doc.getElementById('marketHeader')])if(node)observer.observe(node);
    }
    if(win?.MutationObserver){
      const observer=new win.MutationObserver(schedule);
      observer.observe(doc.body,{attributes:true,attributeFilter:['data-dashboard-mode','data-locked']});
    }
    win?.addEventListener('resize',schedule);
    win?.visualViewport?.addEventListener('resize',schedule);
    win?.visualViewport?.addEventListener('scroll',schedule);
    doc.addEventListener?.('scroll',schedule,true);
    layouts.set(doc,{schedule});position();load();
    return card;
  }
  return {mountAfterStocks,refreshLayout};
});
