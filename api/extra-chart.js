'use strict';

const {
  fetchInvestorSeries,
  fetchMarketFundsSeries,
  fetchVkospiSeries,
  fetchForeignFuturesSeries,
  fetchMarketTurnoverSeries
} = require('../server');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const kind = String(req.query?.kind || '');
    const days = Number(req.query?.days || 120);
    let payload = null;

    if (kind === 'kospi-investor-daily') payload = await fetchInvestorSeries('KOSPI', 'daily', days);
    if (kind === 'kospi-investor-minute') payload = await fetchInvestorSeries('KOSPI', 'minute', days);
    if (kind === 'kosdaq-investor-daily') payload = await fetchInvestorSeries('KOSDAQ', 'daily', days);
    if (kind === 'kosdaq-investor-minute') payload = await fetchInvestorSeries('KOSDAQ', 'minute', days);
    if (kind === 'market-funds') payload = await fetchMarketFundsSeries(days);
    if (kind === 'vkospi') payload = await fetchVkospiSeries(days);
    if (kind === 'foreign-futures-daily') payload = await fetchForeignFuturesSeries(days);
    if (kind === 'market-turnover-daily') payload = await fetchMarketTurnoverSeries(days);

    if (!payload) return res.status(404).json({ ok: false, error: 'no data' });
    if (payload.unavailable) return res.status(404).json({ ok: false, error: payload.error });
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
};
