(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();else root.MarketHeader=factory(root);
})(typeof globalThis!=='undefined'?globalThis:this,function(browser){
  'use strict';
  const POLL_MS=20_000;
  const valid=value=>typeof value==='number'&&Number.isFinite(value);
  const format=value=>valid(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:2}):'-';
  function render(node,quote){
    if(!node)return;
    if(!quote||!valid(quote.price)||quote.price<=0){node.classList.add('stale');node.title='시세 갱신 실패 · 마지막 표시값';return;}
    node.classList.remove('stale');
    node.querySelector('.ticker-price').textContent=format(quote.price);
    const rate=quote.changePercent;
    node.querySelector('.ticker-rate').textContent=valid(rate)?`${rate>0?'+':''}${rate.toFixed(2)}%`:'-';
    node.classList.toggle('up',valid(rate)&&rate>0);node.classList.toggle('down',valid(rate)&&rate<0);
    node.title=`${quote.source || '원천 확인 중'}${quote.sessionLabel?` · ${quote.sessionLabel}`:''}${quote.delayed?' · 지연 시세 가능':''}${quote.asOf?` · 원천 기준 ${quote.asOf}`:''}${quote.queriedAt?` · 조회 ${quote.queriedAt}`:''}`;
  }
  function start({urlFor,getStocks,onQuotes=()=>{},onCharts=()=>{}}){
    let running=false,lastPoll=0;
    const header=browser.document.getElementById('marketHeader');
    const size=()=>browser.document.documentElement.style.setProperty('--market-header-height',`${header.getBoundingClientRect().height}px`);
    new browser.ResizeObserver(size).observe(header);size();
    async function refresh(){
      if(running||browser.document.hidden)return;
      running=true;lastPoll=Date.now();
      try{
        const stocks=getStocks();
        const response=await browser.fetch(urlFor(`/api/market-snapshot?stocks=${encodeURIComponent(stocks.map(item=>item.key).join(','))}`),{cache:'no-store'});
        const json=await response.json();
        if(!response.ok||!json.ok||!Array.isArray(json.quotes))throw new Error('시세 조회 실패');
        for(const {key,quote} of json.quotes)render(browser.document.getElementById(`ticker-${key}`),quote);
        onQuotes(json.quotes);
      }catch(_){header.querySelectorAll('.market-ticker').forEach(node=>render(node,null));}
      finally{
        try{await onCharts();}catch(_){/* each chart retains its source status */}
        running=false;
      }
    }
    const timer=browser.setInterval(refresh,POLL_MS);
    browser.document.addEventListener('visibilitychange',()=>{if(!browser.document.hidden&&Date.now()-lastPoll>=15_000)void refresh();});
    void refresh();
    return {refresh,stop(){browser.clearInterval(timer);}};
  }
  return {POLL_MS,render,start};
});
