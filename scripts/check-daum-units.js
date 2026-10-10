'use strict';

// Run on the deployment server only. Print raw fields without any conversion.
async function main() {
  const response = await fetch('https://finance.daum.net/api/market_index/days?page=1&perPage=1&market=KOSPI&pagination=true', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.daum.net/' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Daum HTTP ${response.status}`);
  const json = await response.json();
  const row = json?.data?.[0];
  if (!row) throw new Error('KOSPI 원본 데이터가 없습니다.');
  console.log(JSON.stringify({ accTradePrice: row.accTradePrice, foreignStraightPurchasePrice: row.foreignStraightPurchasePrice }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
