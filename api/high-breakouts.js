'use strict';

const { fetchHighBreakouts } = require('../breakout-data');

module.exports = async function handler(req, res) {
  try {
    const payload = await fetchHighBreakouts();
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
};
