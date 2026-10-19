'use strict';

const { fetchInvestorTopFlows } = require('../dashboard-data');

module.exports = async function handler(req, res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const payload = await fetchInvestorTopFlows();
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
};
