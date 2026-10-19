// api/chart.js
const { fetchChartSeries } = require('../utils');

module.exports = async function handler(req, res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  const { key = '', interval = '1d' } = req.query;

  if (!key) {
    return res.status(400).json({ ok: false, error: 'Missing key' });
  }

  try {
    const rows = await fetchChartSeries(key, interval);

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'no data' });
    }

    return res.status(200).json({ ok: true, series: rows });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e.message || e),
    });
  }
};
