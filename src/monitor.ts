import { config } from './config/env';
import { loadWatchlist, WatchlistToken, SellBatch } from './config/watchlist';
import { getRecentOHLCV, getTokenPrice, isLowVolContraction } from './services/birdeye';
import { buyWithUsdt, getTokenBalance, getQuote, toRawAmount, USDT_MINT, USDT_DECIMALS } from './services/jupiter';
import { log } from './utils/logger';
import { emit } from './utils/emitter';
import {
  runBuyChecks,
  runPositionChecks,
  recordLoss,
  PositionSnapshot,
} from './strategies/riskManager';
import { loadPositions, savePositions, Position } from './utils/positionStore';

// ─── Position tracking ─────────────────────────────────────────────────────

const positions = loadPositions();
const startedAt = Date.now();

// ─── Single token scan ─────────────────────────────────────────────────────

async function scanToken(token: WatchlistToken): Promise<void> {
  const { symbol, mint, signal, maxBuyUsdt, slippageBps, sellBatches } = token;

  try {
    const candles = await getRecentOHLCV(mint, signal.interval, signal.lookback + 5);
    if (candles.length < signal.lookback + 1) {
      log('WARN', `[${symbol}] Not enough candles (${candles.length}), skipping`);
      return;
    }

    const priceData = await getTokenPrice(mint);
    const currentPrice = priceData.value;

    log('INFO', `[${symbol}] Price: $${currentPrice.toFixed(6)}  24h: ${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h?.toFixed(2) ?? '?'}%`);
    emit('bot:price', { symbol, mint, price: currentPrice, change24h: priceData.priceChange24h ?? 0 });

    // ── Open position: run position-level risk checks first ──────────────
    const position = positions.get(mint);
    if (position) {
      const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      emit('bot:position', { action: 'update', symbol, mint, entryPrice: position.entryPrice, currentPrice, usdtSpent: position.usdtSpent, pnlPct });

      const posSnap: PositionSnapshot = { mint, symbol, entryPrice: position.entryPrice, currentPrice, usdtSpent: position.usdtSpent, boughtAt: position.boughtAt };
      const posRisk = runPositionChecks(posSnap);

      if (!posRisk.ok) {
        // Stop-loss or max hold duration triggered → force-sell entire position
        log('WARN', `[${symbol}] Risk triggered (${posRisk.rule}): ${posRisk.detail} — force selling`);
        await forceClose(position, currentPrice, slippageBps, posRisk.rule);
        return;
      }

      await evaluateSell(position, currentPrice, sellBatches, slippageBps);
      return;
    }

    // ── No position: check buy signal ────────────────────────────────────
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
    emit('bot:signal', { symbol, mint, price: currentPrice });

    // ── Pre-buy risk checks ───────────────────────────────────────────────
    const buyAmount = Math.min(maxBuyUsdt, config.maxBuyUsdt);
    const rawAmount = Math.floor(buyAmount * Math.pow(10, USDT_DECIMALS));
    const quote = await getQuote({ inputMint: USDT_MINT, outputMint: mint, amount: rawAmount, slippageBps });

    const usdtBalance = await getTokenBalance(USDT_MINT);
    const riskResult = runBuyChecks(symbol, positions.size, usdtBalance, buyAmount, quote);

    if (!riskResult.ok) {
      log('WARN', `[${symbol}] Buy blocked by risk (${riskResult.rule}): ${riskResult.detail}`);
      return;
    }

    // ── Execute buy ───────────────────────────────────────────────────────
    const result = await buyWithUsdt(mint, buyAmount, slippageBps, config.dryRun);

    emit('bot:trade', { type: 'buy', symbol, mint, usdtAmount: buyAmount, price: currentPrice, txid: result.txid, dryRun: config.dryRun });

    if (config.dryRun) {
      log('WARN', `[${symbol}] DRY RUN — no real trade executed`);
      return;
    }

    const tokenBal = await getTokenBalance(mint);
    positions.set(mint, { mint, symbol, entryPrice: currentPrice, usdtSpent: buyAmount, tokenBalance: tokenBal, decimals: 0, batchesSold: new Set(), boughtAt: Math.floor(Date.now() / 1000) });
    savePositions(positions);
    emit('bot:position', { action: 'open', symbol, mint, entryPrice: currentPrice, currentPrice, usdtSpent: buyAmount, pnlPct: 0 });
    log('INFO', `[${symbol}] Position opened — ${buyAmount} USDT @ $${currentPrice.toFixed(6)} | tx: ${result.txid}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', `[${symbol}] Scan failed: ${msg}`);
  }
}

// ─── Force close (stop-loss / max hold) ────────────────────────────────────

async function forceClose(position: Position, currentPrice: number, slippageBps: number, reason: string): Promise<void> {
  const { symbol, mint, entryPrice, usdtSpent, tokenBalance, decimals } = position;
  const sellRaw = toRawAmount(tokenBalance, decimals);
  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  const lossUsdt = usdtSpent * Math.max(0, -pnlPct / 100);

  if (config.dryRun) {
    log('WARN', `[${symbol}] DRY RUN force-close (${reason}) — P&L: ${pnlPct.toFixed(2)}%`);
    positions.delete(mint);
    savePositions(positions);
    emit('bot:position', { action: 'close', symbol, mint, entryPrice, currentPrice, usdtSpent, pnlPct });
    emit('bot:trade', { type: 'sell', symbol, mint, usdtAmount: 0, price: currentPrice, txid: 'dry-run', dryRun: true });
    return;
  }

  try {
    const { sellToUsdt } = await import('./services/jupiter');
    const result = await sellToUsdt(mint, sellRaw, slippageBps, false);
    recordLoss(lossUsdt);
    positions.delete(mint);
    savePositions(positions);
    emit('bot:position', { action: 'close', symbol, mint, entryPrice, currentPrice, usdtSpent, pnlPct });
    emit('bot:trade', { type: 'sell', symbol, mint, usdtAmount: usdtSpent + (usdtSpent * pnlPct / 100), price: currentPrice, txid: result.txid, dryRun: false });
    log('INFO', `[${symbol}] Force-closed (${reason}) | P&L: ${pnlPct.toFixed(2)}% | tx: ${result.txid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', `[${symbol}] Force-close failed: ${msg}`);
  }
}

// ─── Normal sell evaluation (batch targets) ────────────────────────────────

async function evaluateSell(position: Position, currentPrice: number, batches: SellBatch[], slippageBps: number): Promise<void> {
  const { symbol, mint, entryPrice, batchesSold, tokenBalance, decimals, usdtSpent } = position;

  const pendingBatches = batches.filter(
    (b) => currentPrice >= entryPrice * b.priceMultiplier && !batchesSold.has(b.priceMultiplier)
  );

  if (pendingBatches.length === 0) {
    const next = batches.filter((b) => !batchesSold.has(b.priceMultiplier)).sort((a, b) => a.priceMultiplier - b.priceMultiplier)[0];
    const targetPrice = next ? (entryPrice * next.priceMultiplier).toFixed(6) : '—';
    log('INFO', `[${symbol}] Holding — next target: $${targetPrice} (${((currentPrice / entryPrice - 1) * 100).toFixed(1)}% from entry)`);
    return;
  }

  for (const batch of pendingBatches) {
    const sellUiAmount = tokenBalance * batch.portion;
    const sellRaw = toRawAmount(sellUiAmount, decimals);
    log('INFO', `[${symbol}] SELL batch ${batch.priceMultiplier}x — ${(batch.portion * 100).toFixed(0)}% of position`);

    if (config.dryRun) {
      log('WARN', `[${symbol}] DRY RUN — sell not executed`);
      batchesSold.add(batch.priceMultiplier);
      emit('bot:trade', { type: 'sell', symbol, mint, usdtAmount: 0, price: currentPrice, txid: 'dry-run', dryRun: true, batch: batch.priceMultiplier });
      continue;
    }

    try {
      const { sellToUsdt } = await import('./services/jupiter');
      const result = await sellToUsdt(mint, sellRaw, slippageBps, false);
      batchesSold.add(batch.priceMultiplier);
      savePositions(positions);
      const realized = usdtSpent * batch.portion * batch.priceMultiplier;
      const cost     = usdtSpent * batch.portion;
      if (realized < cost) recordLoss(cost - realized);
      emit('bot:trade', { type: 'sell', symbol, mint, usdtAmount: realized, price: currentPrice, txid: result.txid, dryRun: false, batch: batch.priceMultiplier });
      log('INFO', `[${symbol}] Sold batch ${batch.priceMultiplier}x | tx: ${result.txid}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', `[${symbol}] Sell batch ${batch.priceMultiplier}x failed: ${msg}`);
    }
  }

  const allSold = batches.every((b) => batchesSold.has(b.priceMultiplier));
  if (allSold) {
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    positions.delete(mint);
    savePositions(positions);
    emit('bot:position', { action: 'close', symbol, mint, entryPrice, currentPrice, usdtSpent, pnlPct });
    log('INFO', `[${symbol}] Position fully closed`);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function runCycle(tokens: WatchlistToken[]): Promise<void> {
  log('INFO', `━━━ Cycle start | ${tokens.length} tokens | DRY_RUN=${config.dryRun} ━━━`);
  emit('bot:cycle', { phase: 'start', tokenCount: tokens.length, positionCount: positions.size });

  for (const token of tokens) {
    await scanToken(token);
    await sleep(1200);
  }

  emit('bot:cycle', { phase: 'complete', tokenCount: tokens.length, positionCount: positions.size });
  log('INFO', `━━━ Cycle complete | open positions: ${positions.size} ━━━\n`);
}

export async function startMonitor(): Promise<void> {
  const tokens = loadWatchlist();
  log('INFO', `Monitor started — watching ${tokens.map((t) => t.symbol).join(', ')}`);
  log('INFO', `Interval: ${config.monitorIntervalSec}s | Max buy: $${config.maxBuyUsdt} USDT | DRY_RUN: ${config.dryRun}`);
  log('INFO', `Risk: stop-loss ${config.stopLossPct}% | max positions ${config.maxOpenPositions} | daily loss cap $${config.maxDailyLossUsdt}`);

  emit('bot:status', { running: true, dryRun: config.dryRun, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });

  await runCycle(tokens);

  setInterval(async () => {
    emit('bot:status', { running: true, dryRun: config.dryRun, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
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
