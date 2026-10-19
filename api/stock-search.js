'use strict';
const { fetchStockSearch } = require('../stock-search');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','no-store');
  const query = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  if (query.length > 80) return res.status(400).json({ok:false,error:'검색어는 80자 이하로 입력하세요.'});
  try { return res.status(200).json({ok:true,rows:await fetchStockSearch(query)}); }
  catch (_) { return res.status(503).json({ok:false,error:'종목 검색 원천을 확인하지 못했습니다. 잠시 후 다시 검색하세요.'}); }
};
