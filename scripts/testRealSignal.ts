/**
 * 用真实数据发送 TG 买入信号通知（Birdeye + Jupiter）
 */
import 'dotenv/config';
import { checkEntryPreConditions } from '../src/services/birdeye';
import { getQuote, USDT_MINT, USDT_DECIMALS } from '../src/services/jupiter';
import { notifyBuySignal } from '../src/services/telegramNotifier';
import { getDexScreenerSummary } from '../src/services/dexscreener';

const MINT     = 'CboMcTUYUcy9E6B3yGdFn6aEsGUnYV6yWeoeukw6pump';
const BUY_USDT = 30;

async function main() {
  const [ds, pre] = await Promise.all([
    getDexScreenerSummary(MINT),
    checkEntryPreConditions(MINT),
  ]);

  console.log(`Token   : (fetching symbol below)`);
  console.log(`MC      : $${ds.marketCap.toLocaleString()}`);
  console.log(`24h     : ${ds.priceChange24h}%`);
  console.log(`Age     : ${ds.ageDays.toFixed(1)} days`);
  console.log(`Path    : ${pre.path}`);
  console.log(`ATH MC  : $${pre.athMarketCapUsd.toLocaleString()}`);
  console.log(`Drawdown: ${pre.drawdownPct.toFixed(2)}%`);
  console.log(`AmpBars : ${pre.lowAmpBars}`);
  console.log(`VolBars : ${pre.lowVolBars}  (threshold: $${pre.volThresholdUsd.toLocaleString()})`);
  console.log(`Passed  : ${pre.passed} — ${pre.reason}`);

  let priceImpactPct = 0;
  try {
    const rawAmount = Math.floor(BUY_USDT * Math.pow(10, USDT_DECIMALS));
    const quote = await getQuote({ inputMint: USDT_MINT, outputMint: MINT, amount: rawAmount, slippageBps: 300 });
    priceImpactPct = parseFloat(quote.priceImpactPct);
    console.log(`Impact  : ${priceImpactPct.toFixed(4)}%`);
  } catch { console.warn('Jupiter quote failed'); }

  // 从 DexScreener 拿 symbol（Birdeye overview 省一次请求）
  const res = await import('axios').then(m =>
    m.default.get(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`, { timeout: 10_000 })
  );
  const ref    = (res.data.pairs ?? []).sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const symbol = ref?.baseToken?.symbol ?? 'UNKNOWN';

  console.log(`\nSending TG notification for ${symbol}...`);
  await notifyBuySignal({
    symbol,
    mint:               MINT,
    athMarketCapUsd:    pre.athMarketCapUsd,
    drawdownPct:        pre.drawdownPct,
    lowAmpBars:         pre.lowAmpBars,
    lowVolBars:         pre.lowVolBars,
    volThresholdUsd:    pre.volThresholdUsd,
    path:               pre.path,
    priceImpactPct,
    buyAmountUsdt:      BUY_USDT,
    maxPriceImpactPct:  3,
  });
  console.log('Done ✅');
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
