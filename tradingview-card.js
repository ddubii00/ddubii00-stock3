(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.TradingViewCard=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SYMBOL='WHSELFINVEST:USTECH100CFD';
  function mountAfterStocks(doc){
    const anchor=doc.getElementById('selectedStockCharts');
    if(!anchor)return null;
    const existing=doc.getElementById('tradingview-USTECH100');
    if(existing)return existing;
    const card=doc.createElement('section');
    card.id='tradingview-USTECH100';card.className='card span-6 technical-card tradingview-card';
    const heading=doc.createElement('div');heading.className='head-row';
    const title=doc.createElement('div');title.className='title';title.textContent='USTECH100 (나스닥100 CFD)';
    const retry=doc.createElement('button');retry.className='btn outline';retry.type='button';retry.textContent='다시 연결';
    retry.setAttribute('aria-label','USTECH100 위젯 다시 연결');
    heading.append(title,retry);
    const body=doc.createElement('div');body.id='tvchart-USTECH100';
    body.className='chart reference-chart tradingview-widget-container';
    body.setAttribute('aria-label','USTECH100 TradingView 차트');
    const widget=doc.createElement('div');widget.className='tradingview-widget-container__widget';
    const footer=doc.createElement('div');footer.className='tradingview-widget-copyright';
    const link=doc.createElement('a');
    link.href=`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`;
    link.target='_blank';link.rel='noopener nofollow';link.textContent='USTECH100 차트 · TradingView';
    footer.append(link);
    const status=doc.createElement('div');status.className='chart-note';status.setAttribute('role','status');
    status.title='실시간·지연 여부와 거래 상태는 TradingView 위젯 안에서 확인하세요.';
    card.append(heading,body,status);
    // The official iframe owns its live feed. Do not read its prices or recreate it on the app's 20-second poll.
    function load(){
      widget.replaceChildren();body.replaceChildren(widget,footer);
      status.textContent='TradingView · WH SelfInvest';
      const script=doc.createElement('script');script.type='text/javascript';script.async=true;
      script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.textContent=JSON.stringify({autosize:true,symbol:SYMBOL,interval:'1',
        timezone:'Asia/Seoul',theme:'light',style:'1',locale:'kr',
        allow_symbol_change:false,hide_side_toolbar:false,hide_top_toolbar:false,
        hide_legend:false,save_image:false,calendar:false,studies:[]});
      script.onerror=()=>{if(script.isConnected)status.textContent='위젯 연결 실패 · 다시 연결해주세요.';};
      body.append(script);
    }
    retry.addEventListener('click',load);
    anchor.after(card);load();
    return card;
  }
  return {mountAfterStocks};
});
