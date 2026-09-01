'use strict';

const { fetchInvestorTopFlows } = require('../dashboard-data');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const forceRefresh = String(req.query?.refresh || '') === '1';
    const payload = await fetchInvestorTopFlows(null, forceRefresh);
    res.setHeader('Cache-Control', forceRefresh ? 'no-store' : 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
};
