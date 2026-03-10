import { config } from './config/env';
import { loadWatchlist, WatchlistToken, SellBatch } from './config/watchlist';
import { getRecentOHLCV, getTokenPrice, isLowVolContraction } from './services/birdeye';
import { buyWithUsdt, getTokenBalance, toRawAmount } from './services/jupiter';
import { log } from './utils/logger';

// ─── Position tracking ─────────────────────────────────────────────────────

interface Position {
  mint: string;
  symbol: string;
  entryPrice: number;       // price in USDT when bought
  usdtSpent: number;        // USDT spent
  tokenBalance: number;     // current token balance (ui amount)
  decimals: number;
  batchesSold: Set<number>; // set of priceMultipliers already executed
  boughtAt: number;         // unix timestamp
}

const positions = new Map<string, Position>(); // keyed by mint

// ─── Single token scan ─────────────────────────────────────────────────────

async function scanToken(token: WatchlistToken): Promise<void> {
  const { symbol, mint, signal, maxBuyUsdt, slippageBps, sellBatches } = token;

  try {
    // 1. Fetch recent candles for signal detection
    const candles = await getRecentOHLCV(mint, signal.interval, signal.lookback + 5);

    if (candles.length < signal.lookback + 1) {
      log('WARN', `[${symbol}] Not enough candles (${candles.length}), skipping`);
      return;
    }

    // 2. Get current price
    const priceData = await getTokenPrice(mint);
    const currentPrice = priceData.value;

    log('INFO', `[${symbol}] Price: $${currentPrice.toFixed(6)}  24h: ${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h?.toFixed(2) ?? '?'}%`);

    // 3. Check open position → evaluate sell batches
    const position = positions.get(mint);
    if (position) {
      await evaluateSell(position, currentPrice, sellBatches, slippageBps);
      return; // don't re-buy while holding
    }

    // 4. No position → check buy signal
    const triggered = isLowVolContraction(candles, {
      lookback: signal.lookback,
      maxAmplitudePct: signal.maxAmplitudePct,
      volumeContractionRatio: signal.volumeContractionRatio,
    });

    if (!triggered) {
      log('INFO', `[${symbol}] No signal`);
      return;
    }

    log('INFO', `[${symbol}] *** BUY SIGNAL detected ***`);

    // 5. Execute buy
    const buyAmount = Math.min(maxBuyUsdt, config.maxBuyUsdt);
    const result = await buyWithUsdt(mint, buyAmount, slippageBps, config.dryRun);

    if (config.dryRun) {
      log('WARN', `[${symbol}] DRY RUN — no real trade executed`);
      return;
    }

    // 6. Record position
    const tokenBal = await getTokenBalance(mint);
    positions.set(mint, {
      mint,
      symbol,
      entryPrice: currentPrice,
      usdtSpent: buyAmount,
      tokenBalance: tokenBal,
      decimals: 0, // will be resolved on first sell
      batchesSold: new Set(),
      boughtAt: Math.floor(Date.now() / 1000),
    });

    log('INFO', `[${symbol}] Position opened — ${buyAmount} USDT @ $${currentPrice.toFixed(6)} | tx: ${result.txid}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', `[${symbol}] Scan failed: ${msg}`);
  }
}

// ─── Sell evaluation ───────────────────────────────────────────────────────

async function evaluateSell(
  position: Position,
  currentPrice: number,
  batches: SellBatch[],
  slippageBps: number
): Promise<void> {
  const { symbol, mint, entryPrice, batchesSold, tokenBalance } = position;

  const pendingBatches = batches.filter(
    (b) => currentPrice >= entryPrice * b.priceMultiplier && !batchesSold.has(b.priceMultiplier)
  );

  if (pendingBatches.length === 0) {
    const bestTarget = batches
      .filter((b) => !batchesSold.has(b.priceMultiplier))
      .sort((a, b) => a.priceMultiplier - b.priceMultiplier)[0];
    const targetPrice = bestTarget ? (entryPrice * bestTarget.priceMultiplier).toFixed(6) : '—';
    log('INFO', `[${symbol}] Holding — next target: $${targetPrice} (${((currentPrice / entryPrice - 1) * 100).toFixed(1)}% from entry)`);
    return;
  }

  for (const batch of pendingBatches) {
    const sellUiAmount = tokenBalance * batch.portion;
    const sellRaw = toRawAmount(sellUiAmount, position.decimals);

    log('INFO', `[${symbol}] SELL batch ${batch.priceMultiplier}x — ${(batch.portion * 100).toFixed(0)}% of position`);

    if (config.dryRun) {
      log('WARN', `[${symbol}] DRY RUN — sell not executed`);
      batchesSold.add(batch.priceMultiplier);
      continue;
    }

    try {
      const { sellToUsdt } = await import('./services/jupiter');
      const result = await sellToUsdt(mint, sellRaw, slippageBps, false);
      batchesSold.add(batch.priceMultiplier);
      log('INFO', `[${symbol}] Sold batch ${batch.priceMultiplier}x | tx: ${result.txid}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', `[${symbol}] Sell batch ${batch.priceMultiplier}x failed: ${msg}`);
    }
  }

  // Clear position if all batches are sold
  const allSold = batches.every((b) => batchesSold.has(b.priceMultiplier));
  if (allSold) {
    positions.delete(mint);
    log('INFO', `[${symbol}] Position fully closed`);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function runCycle(tokens: WatchlistToken[]): Promise<void> {
  log('INFO', `━━━ Cycle start | ${tokens.length} tokens | DRY_RUN=${config.dryRun} ━━━`);

  for (const token of tokens) {
    await scanToken(token);
    await sleep(1200); // rate limit guard between tokens
  }

  log('INFO', `━━━ Cycle complete | open positions: ${positions.size} ━━━\n`);
}

export async function startMonitor(): Promise<void> {
  const tokens = loadWatchlist();

  log('INFO', `Monitor started — watching ${tokens.map((t) => t.symbol).join(', ')}`);
  log('INFO', `Interval: ${config.monitorIntervalSec}s | Max buy: $${config.maxBuyUsdt} USDT | DRY_RUN: ${config.dryRun}`);

  // Run first cycle immediately
  await runCycle(tokens);

  // Then run on interval
  setInterval(async () => {
    try {
      await runCycle(tokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', `Cycle failed: ${msg}`);
    }
  }, config.monitorIntervalSec * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
