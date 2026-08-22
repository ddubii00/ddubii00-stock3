'use strict';

const { fetchBondYields } = require('../tradingview-data');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const rows = await fetchBondYields();
    return res.status(200).json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
};
