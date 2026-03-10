import { log } from './utils/logger';
import { config } from './config/env';
import {
  getTokenPrice,
  getTokenOverview,
  getAllOHLCV,
  isLowVolContraction,
  avgAmplitude,
  avgVolume,
} from './services/birdeye';
import {
  getSolBalance,
  getTokenBalance,
  getQuote,
  buyWithUsdt,
  SOL_MINT,
  USDT_MINT,
  USDT_DECIMALS,
} from './services/jupiter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  log('INFO', '========================================');
  log('INFO', '  Solana Memecoin Quant Bot - Starting  ');
  log('INFO', '========================================');
  log('INFO', `RPC Endpoint : ${config.rpcUrl}`);
  log('INFO', `Birdeye Key  : ${config.birdeyeApiKey ? '***set***' : '(not set)'}`);
  log('INFO', `Wallet Key   : ${config.walletPrivateKey ? '***set***' : '(not set)'}`);

  log('INFO', '--- Birdeye smoke test (WSOL) ---');

  // 1. Real-time price
  const price = await getTokenPrice(SOL_MINT);
  log('INFO', `Price        : $${price.value.toFixed(4)}  (24h ${price.priceChange24h >= 0 ? '+' : ''}${price.priceChange24h?.toFixed(2) ?? 'N/A'}%)`);

  // 2. Token overview
  await sleep(1100);
  const overview = await getTokenOverview(SOL_MINT);
  log('INFO', `Token        : ${overview.symbol} / ${overview.name}`);
  log('INFO', `Market Cap   : $${(overview.marketCap / 1e6).toFixed(2)}M`);
  log('INFO', `24h Volume   : $${(overview.v24hUSD / 1e6).toFixed(2)}M`);
  log('INFO', `Liquidity    : $${(overview.liquidity / 1e6).toFixed(2)}M`);
  log('INFO', `Holders      : ${overview.holder.toLocaleString()}`);

  // 3. 1H K-line — all available (up to 2 years)
  await sleep(2000);
  log('INFO', 'Fetching all 1H candles...');
  const candles1H = await getAllOHLCV(SOL_MINT, '1H');
  log('INFO', `1H candles   : ${candles1H.length} fetched`);
  log('INFO', `Avg amplitude: ${avgAmplitude(candles1H).toFixed(2)}%`);
  log('INFO', `Avg volume   : $${(avgVolume(candles1H) / 1e3).toFixed(1)}K`);
  const earliest1H = new Date(candles1H[0]!.unixTime * 1000).toISOString().slice(0, 10);
  log('INFO', `Earliest 1H  : ${earliest1H}`);

  // 4. 1D K-line — all available (up to 2 years)
  await sleep(2000);
  log('INFO', 'Fetching all 1D candles...');
  const candles1D = await getAllOHLCV(SOL_MINT, '1D');
  log('INFO', `1D candles   : ${candles1D.length} fetched`);
  const earliest1D = new Date(candles1D[0]!.unixTime * 1000).toISOString().slice(0, 10);
  log('INFO', `Earliest 1D  : ${earliest1D}`);

  // 5. Signal detection stub
  const signal = isLowVolContraction(candles1H, {
    lookback: 5,
    maxAmplitudePct: 5,
    volumeContractionRatio: 0.7,
  });
  log('INFO', `Low-vol signal (1H): ${signal ? 'BUY SIGNAL' : 'no signal'}`);

  // 6. Jupiter smoke test (dry-run only — no real transaction)
  log('INFO', '--- Jupiter smoke test ---');
  await sleep(3000); // allow network to settle after Birdeye session
  const solBal  = await getSolBalance();
  const usdtBal = await getTokenBalance(USDT_MINT);
  log('INFO', `Wallet SOL   : ${solBal.toFixed(4)} SOL`);
  log('INFO', `Wallet USDT  : ${usdtBal.toFixed(2)} USDT`);

  // Get a quote: 10 USDT → SOL (just to verify the API works)
  const quote = await getQuote({
    inputMint:   USDT_MINT,
    outputMint:  SOL_MINT,
    amount:      10 * Math.pow(10, USDT_DECIMALS), // 10 USDT in raw units
    slippageBps: 100,
  });
  const inUsdt = (Number(quote.inAmount)  / 1e6).toFixed(2);
  const outSol = (Number(quote.outAmount) / 1e9).toFixed(4);
  log('INFO', `Quote        : ${inUsdt} USDT → ${outSol} SOL`);
  log('INFO', `Price impact : ${Number(quote.priceImpactPct).toFixed(4)}%`);
  log('INFO', `Route hops   : ${quote.routePlan.length}`);

  // Dry-run buy: 10 USDT → SOL (no actual transaction sent)
  const result = await buyWithUsdt(SOL_MINT, 10, 100, /* dryRun */ true);
  log('INFO', `Dry-run txid : ${result.txid}`);

  log('INFO', '--- Smoke test complete ---');
  log('INFO', 'All modules loaded. Ready to trade.');
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
