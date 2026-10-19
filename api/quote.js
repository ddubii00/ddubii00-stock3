// api/quote.js
const { fetchStooq } = require('../utils');

module.exports = async function handler(req, res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  const { symbol = '' } = req.query;
  if (!symbol) {
    return res.status(400).json({ ok: false, error: 'Missing symbol' });
  }
  try {
    const q = await require('../market-quotes').quote(symbol) || await fetchStooq(symbol);
    if (!q) return res.status(404).json({ ok: false, error: 'no data' });
    return res.status(200).json({ ok: true, quote: q });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
