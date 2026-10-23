'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mountAfterStocks}=require('../tradingview-card');

// A local DOM double: no external widget, source data or credentials are loaded.
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};}
  get isConnected(){return this.root===true || !!this.parentNode?.isConnected;}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  remove(){if(this.parentNode){const items=this.parentNode.children;items.splice(items.indexOf(this),1);this.parentNode=null;}}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
  after(node){node.remove();const parent=this.parentNode;node.parentNode=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(type,handler){this.listeners[type]=handler;}
}
function fixture(){
  const root=new Element('div');root.root=true;
  const stocks=new Element('div');stocks.id='selectedStockCharts';
  const peer=new Element('section');root.append(stocks,peer);
  const all=node=>[node,...node.children.flatMap(all)];
  const doc={createElement:tag=>new Element(tag),getElementById:id=>all(root).find(node=>node.id===id)};
  return{root,stocks,peer,doc};
}
function parts(card){
  const frame=card.children[0], [body,status]=frame.children;
  return{frame,body,status,script:body.children.find(node=>node.tagName==='script')};
}

test('the official USTECH100 embed follows all registered stock cards and mounts only once',()=>{
  const f=fixture();const card=mountAfterStocks(f.doc);
  assert.deepEqual(f.root.children,[f.stocks,card,f.peer]);
  const {frame,body,script}=parts(card);
  assert.equal(frame.id,'tvchart-USTECH100');
  assert.match(card.className,/span-6/);assert.match(frame.className,/chart reference-chart/);
  assert.equal(body.className,'tradingview-widget-container');assert.equal(body.parentNode,frame);
  assert.equal(card.children.length,1);assert.equal(parts(card).status.hidden,true);
  assert.equal(card.attributes['data-dashboard-title'],'USTECH100 (나스닥100 CFD)');
  assert.equal(script.src,'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js');
  assert.equal(script.async,true);
  const config=JSON.parse(script.textContent);
  assert.equal(config.symbol,'WHSELFINVEST:USTECH100CFD');assert.equal(config.interval,'1');
  assert.equal(config.timezone,'Asia/Seoul');assert.equal(config.locale,'kr');assert.equal(config.autosize,true);
  assert.equal(config.allow_symbol_change,false);
  assert.equal(config.hide_top_toolbar,false);assert.equal(config.hide_legend,true);
  const copyright=body.children.find(node=>node.className==='tradingview-widget-copyright');
  assert.equal(new URL(copyright.children[0].href).searchParams.get('symbol'),config.symbol);
  assert.match(copyright.children[0].textContent,/TradingView/);
  f.stocks.append(new Element('section'),new Element('section'));
  assert.equal(mountAfterStocks(f.doc),card);assert.equal(f.root.children[1],card);
  assert.equal(parts(card).script,script); // Polls/remount attempts must not reset the widget's viewport.
});

test('connection failures show an in-frame notice without a heading, retry button or reserved footer space',()=>{
  const f=fixture();const card=mountAfterStocks(f.doc);
  const first=parts(card);first.script.onerror();
  assert.equal(first.status.hidden,false);assert.match(first.status.textContent,/화면을 새로고침/);
  assert.equal(first.status.parentNode,first.frame);assert.equal(card.children.length,1);
  assert.equal(mountAfterStocks(f.doc),card);assert.equal(parts(card).script,first.script);
  assert.deepEqual(f.root.children,[f.stocks,card,f.peer]);
});

test('no external script is inserted before the stock chart area is initialized',()=>{
  const f=fixture();f.stocks.remove();
  assert.equal(mountAfterStocks(f.doc),null);assert.deepEqual(f.root.children,[f.peer]);
});
