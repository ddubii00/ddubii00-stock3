'use strict';
module.exports = async function handler(req,res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  res.setHeader('Cache-Control','no-store');
  const raw=String(req.query?.stocks || '');
  const stocks=raw?raw.split(','):[];
  if(stocks.length>20 || raw.length>600 || stocks.some(key=>!require('../stock-search').parseStockKey(key))) return res.status(400).json({ok:false,error:'종목 목록을 확인하세요.'});
  try { return res.status(200).json(await require('../market-quotes').snapshot(stocks)); }
  catch (_) { return res.status(503).json({ok:false,error:'시세 원천을 확인하지 못했습니다.'}); }
};
