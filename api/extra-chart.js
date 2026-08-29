'use strict';

const {
  fetchInvestorSeries,
  fetchMarketFundsSeries,
  fetchVkospiSeries,
  fetchForeignFuturesSeries,
  fetchForeignFuturesMinuteSeries,
  fetchPriceMinuteSeries,
  fetchMarketTurnoverSeries,
  fetchM2TrendSeries,
  fetchCentralBankAssetsSeries,
  fetchKoreaPrivateBondSeries,
  fetchPrivateCreditGdpSeries
} = require('../server');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const kind = String(req.query?.kind || '');
    const days = Number(req.query?.days || 200);
    let payload = null;

    if (kind === 'kospi-investor-daily') payload = await fetchInvestorSeries('KOSPI', 'daily', days);
    if (kind === 'kospi-investor-minute') payload = await fetchInvestorSeries('KOSPI', 'minute', days);
    if (kind === 'kosdaq-investor-daily') payload = await fetchInvestorSeries('KOSDAQ', 'daily', days);
    if (kind === 'kosdaq-investor-minute') payload = await fetchInvestorSeries('KOSDAQ', 'minute', days);
    if (kind === 'market-funds') payload = await fetchMarketFundsSeries(days);
    if (kind === 'vkospi') payload = await fetchVkospiSeries(days);
    if (kind === 'foreign-futures-daily') payload = await fetchForeignFuturesSeries(days);
    if (kind === 'foreign-futures-minute') payload = await fetchForeignFuturesMinuteSeries();
    if (kind === 'kospi-futures-minute') payload = await fetchPriceMinuteSeries('KOSPI_FUTURES', 'KOSPI200 선물', 'P');
    if (kind === 'usdkrw-minute') payload = await fetchPriceMinuteSeries('USDKRW', '원/달러', '원');
    if (kind === 'market-turnover-daily') payload = await fetchMarketTurnoverSeries(days);
    if (kind === 'm2-trend') payload = await fetchM2TrendSeries();
    if (kind === 'central-bank-assets') payload = await fetchCentralBankAssetsSeries();
    if (kind === 'korea-private-bonds') payload = await fetchKoreaPrivateBondSeries();
    if (kind === 'private-credit-gdp') payload = await fetchPrivateCreditGdpSeries();

    if (!payload) return res.status(404).json({ ok: false, error: 'no data' });
    if (payload.unavailable) return res.status(404).json({ ok: false, error: payload.error });
    return res.status(200).json({ ok: true, ...payload });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
};
