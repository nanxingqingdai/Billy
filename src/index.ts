import { loadConfig, loadWatchlist } from './config';
import { detectBuySignal, formatSignal } from './services/signal';
import { BuySignal } from './types';
import { log } from './utils/logger';

const signalHistory: BuySignal[] = [];

async function runMonitorCycle() {
  const config = loadConfig();
  const tokens = loadWatchlist();

  log.info(`━━━ Monitor cycle start | ${tokens.length} tokens | ${config.klineType} candles | amp < ${config.maxAmplitudePct}% ━━━`);

  for (const token of tokens) {
    const signal = await detectBuySignal(token, config);

    if (signal) {
      signalHistory.push(signal);
      log.signal(formatSignal(signal));

      // Save signal to file for persistence
      const fs = await import('fs');
      const signalFile = 'signals.log';
      const entry = JSON.stringify({
        time: new Date(signal.detectedAt).toISOString(),
        symbol: signal.token.symbol,
        address: signal.token.address,
        price: signal.currentPrice,
        avgAmplitude: signal.avgAmplitudePct,
        avgVolume: signal.avgVolume,
      }) + '\n';
      fs.appendFileSync(signalFile, entry);
    }

    // Rate limit: small delay between API calls to respect free tier
    await sleep(1500);
  }

  log.info(`━━━ Monitor cycle complete | Signals found this session: ${signalHistory.length} ━━━`);
}

async function main() {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   Billy - Solana Memecoin Signal Monitor  ║
  ║   v0.1.0 - Phase 1: Signal Detection     ║
  ╚═══════════════════════════════════════════╝
  `);

  const config = loadConfig();
  const tokens = loadWatchlist();

  log.info(`Config: ${config.klineType} candles, ${config.candleCount} consecutive, amplitude < ${config.maxAmplitudePct}%`);
  log.info(`Watchlist: ${tokens.map(t => t.symbol).join(', ')}`);
  log.info(`Monitor interval: ${config.monitorInterval}s`);
  log.info(`Starting monitor loop...\n`);

  // Run first cycle immediately
  await runMonitorCycle();

  // Then run on interval
  setInterval(async () => {
    try {
      await runMonitorCycle();
    } catch (error: any) {
      log.error(`Monitor cycle failed: ${error.message}`);
    }
  }, config.monitorInterval * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  log.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
