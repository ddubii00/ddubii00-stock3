'use strict';

const { fetchDashboardPanels } = require('../dashboard-data');

module.exports = async function handler(req, res) {
  try {
    const watchlist = Array.isArray(req.query?.watchlist) ? req.query.watchlist.join(',') : (req.query?.watchlist || '');
    const forceRefresh = String(req.query?.refresh || '') === '1';
    const payload = await fetchDashboardPanels(watchlist, forceRefresh);
    res.setHeader('Cache-Control', forceRefresh ? 'no-store' : 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error.message || error) });
  }
};
