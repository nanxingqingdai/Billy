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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wrapped SOL mint — used as a smoke test
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

  log('INFO', '--- Smoke test complete ---');
  log('INFO', 'All modules loaded. Ready to trade.');
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
