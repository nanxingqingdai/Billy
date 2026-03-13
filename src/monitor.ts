import { config } from './config/env';
import { getActiveTokens, WatchlistToken, SellBatch } from './config/watchlist';
import { getValidatedPrice, getRecentOHLCV, checkEntryPreConditions } from './services/marketDataFallback';
import { getTokenOverview } from './services/geckoTerminal';
import { buyWithUsdt, getTokenBalance, getSolBalance, getQuote, toRawAmount, USDT_MINT, USDT_DECIMALS } from './services/jupiter';
import { log } from './utils/logger';
import { emit } from './utils/emitter';
import {
  runBuyChecks,
  runPositionChecks,
  recordLoss,
  PositionSnapshot,
} from './strategies/riskManager';
import { loadPositions, savePositions, Position } from './utils/positionStore';
import { notifyBuySignal } from './services/telegramNotifier';
import { isGeminiConfigured, screenToken } from './services/gemini';
import { recordDailySignal, recordDailyTrade } from './services/dailySummary';
import { isKimiConfigured, getTokenCommentary, getSignalSecondOpinion } from './services/kimi';

// ─── Position tracking ─────────────────────────────────────────────────────

const positions = loadPositions();
const startedAt = Date.now();

// ─── Signal cooldown (prevent repeated TG notifications for the same token) ─
//   Mature (>40d) : 48 小时冷却
//   Young  (≤40d) : 4 小时冷却，且每自然日最多通知 2 次

import type { TokenPath } from './services/birdeye';

const COOLDOWN_MATURE_MS        = 48 * 60 * 60 * 1000;
const COOLDOWN_YOUNG_MS         =  4 * 60 * 60 * 1000;
const YOUNG_MAX_PER_DAY         = 2;

const _lastSignalTime  = new Map<string, number>();                          // mint → last notify timestamp
const _dailyCount      = new Map<string, { dateUtc: string; count: number }>(); // mint → daily count

function todayUtc(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Returns null if OK to send, or a human-readable reason string if blocked.
 */
function signalBlockReason(mint: string, path: TokenPath): string | null {
  const cooldownMs = path === 'mature' ? COOLDOWN_MATURE_MS : COOLDOWN_YOUNG_MS;
  const last = _lastSignalTime.get(mint);
  if (last !== undefined && Date.now() - last < cooldownMs) {
    const remainMin = Math.ceil((cooldownMs - (Date.now() - last)) / 60_000);
    const label = path === 'mature' ? '48h' : '4h';
    return `${label} 冷却中，还需 ${remainMin} 分钟`;
  }
  if (path !== 'mature') {
    const today = todayUtc();
    const daily = _dailyCount.get(mint);
    if (daily && daily.dateUtc === today && daily.count >= YOUNG_MAX_PER_DAY) {
      return `今日已通知 ${YOUNG_MAX_PER_DAY} 次，明日 UTC 0 点重置`;
    }
  }
  return null;
}

function markSignalSent(mint: string, path: TokenPath): void {
  _lastSignalTime.set(mint, Date.now());
  if (path !== 'mature') {
    const today = todayUtc();
    const daily = _dailyCount.get(mint);
    if (!daily || daily.dateUtc !== today) {
      _dailyCount.set(mint, { dateUtc: today, count: 1 });
    } else {
      _dailyCount.set(mint, { dateUtc: today, count: daily.count + 1 });
    }
  }
}

// ─── Single token scan ─────────────────────────────────────────────────────

async function scanToken(token: WatchlistToken, solBalance: number, usdtBalance: number): Promise<void> {
  const { symbol, mint, signal, maxBuyUsdt, slippageBps, sellBatches } = token;

  try {
    // 拉取足够多的K线：近10根用于信号判断，全量用于缩量基准
    const candles = await getRecentOHLCV(mint, signal.interval, 500);
    if (candles.length < 11) {
      log('WARN', `[${symbol}] Not enough candles (${candles.length}), skipping`);
      return;
    }

    const closedCandles = candles.slice(0, -1);          // 排除最新可能未收盘的K线
    const recent10      = closedCandles.slice(-10);       // 最近10根已收盘

    // ── 低振幅根数检查：最近10根已收盘K线中达标根数 ──────────────────────
    const minLowAmpBars = signal.minLowAmpBars ?? 1;
    if (minLowAmpBars > 1) {
      const lowAmpCount = recent10.filter(c => c.o > 0 && ((c.h - c.l) / c.o) * 100 < signal.maxAmplitudePct).length;
      if (lowAmpCount < minLowAmpBars) {
        log('INFO', `[${symbol}] 低振幅根数不足 (${lowAmpCount}/${minLowAmpBars})，跳过`);
        return;
      }
      log('INFO', `[${symbol}] 低振幅根数通过 (${lowAmpCount}/${minLowAmpBars})`);
    }

    const priceData = await getValidatedPrice(mint);
    const currentPrice = priceData.value;

    log('INFO', `[${symbol}] Price: $${currentPrice.toFixed(6)}  24h: ${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h?.toFixed(2) ?? '?'}%`);
    emit('bot:price', { symbol, mint, price: currentPrice, change24h: priceData.priceChange24h ?? 0 });

    // ── Kimi 行情解读（fire-and-forget，不阻塞扫描循环）─────────────────
    if (isKimiConfigured()) {
      const pos = positions.get(mint);
      getTokenCommentary({
        symbol,
        price:       currentPrice,
        change24h:   priceData.priceChange24h ?? 0,
        hasPosition: Boolean(pos),
        entryPrice:  pos?.entryPrice,
        pnlPct:      pos ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : undefined,
      }).then(text => {
        if (text) emit('bot:commentary', { symbol, mint, text });
      }).catch(() => {});
    }

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

    // ── No position: entry pre-conditions → main signal ──────────────────
    const pre = await checkEntryPreConditions(mint);
    if (!pre.passed) {
      log('INFO', `[${symbol}] Pre-condition blocked: ${pre.reason}`);
      return;
    }
    log('INFO', `[${symbol}] Pre-conditions OK — drawdown ${pre.drawdownPct.toFixed(1)}% | age ${Math.floor(pre.ageDays)}d | ampBars ${pre.lowAmpBars} | volBars ${pre.lowVolBars} (< $${pre.volThresholdUsd.toLocaleString()})`);

    // ── 缩量检查：近10根均量 / 全量历史均量 < volumeContractionRatio ────────
    const globalAvgVol  = closedCandles.reduce((s, c) => s + c.v, 0) / closedCandles.length;
    const recent10AvgVol = recent10.reduce((s, c) => s + c.v, 0) / recent10.length;
    const volRatio      = globalAvgVol > 0 ? recent10AvgVol / globalAvgVol : 1;

    if (volRatio >= signal.volumeContractionRatio) {
      log('INFO', `[${symbol}] 缩量不足 (近10均量/全量均量 = ${(volRatio * 100).toFixed(1)}%，需 < ${signal.volumeContractionRatio * 100}%)`);
      return;
    }
    log('INFO', `[${symbol}] 缩量通过 (近10均量/全量均量 = ${(volRatio * 100).toFixed(1)}% < ${signal.volumeContractionRatio * 100}%)`);

    log('INFO', `[${symbol}] *** BUY SIGNAL detected ***`);
    emit('bot:signal', { symbol, mint, price: currentPrice });

    // ── 冷却期 / 每日次数检查 ─────────────────────────────────────────────
    const blockReason = signalBlockReason(mint, pre.path);
    if (blockReason) {
      log('INFO', `[${symbol}] 通知已屏蔽（${blockReason}）`);
      return;
    }

    // ── Gemini 代币筛查 ───────────────────────────────────────────────────
    if (isGeminiConfigured()) {
      const screen = await screenToken({
        symbol,
        mint,
        athMarketCapUsd: pre.athMarketCapUsd,
        drawdownPct:     pre.drawdownPct,
        ageDays:         pre.ageDays,
        path:            pre.path,
      });
      if (!screen.pass) {
        log('INFO', `[${symbol}] Gemini 筛查未通过: ${screen.reason}`);
        return;
      }
      log('INFO', `[${symbol}] Gemini 筛查通过: ${screen.reason}`);
    }

    // ── Pre-buy risk checks ───────────────────────────────────────────────
    const buyAmount = Math.min(maxBuyUsdt, config.maxBuyUsdt);
    const rawAmount = Math.floor(buyAmount * Math.pow(10, USDT_DECIMALS));
    const quote = await getQuote({ inputMint: USDT_MINT, outputMint: mint, amount: rawAmount, slippageBps });

    const riskResult = runBuyChecks(symbol, positions.size, usdtBalance, solBalance, buyAmount, quote);

    // ── TG 通知（无论是否 dryRun，只要信号有效就通知） ──────────────────
    await notifyBuySignal({
      symbol,
      mint,
      athMarketCapUsd: pre.athMarketCapUsd,
      drawdownPct:     pre.drawdownPct,
      ageDays:         pre.ageDays,
      lowAmpBars:      pre.lowAmpBars,
      lowVolBars:      pre.lowVolBars,
      volThresholdUsd: pre.volThresholdUsd,
      path:            pre.path,
      priceImpactPct:  parseFloat(quote.priceImpactPct),
      buyAmountUsdt:   buyAmount,
    });
    markSignalSent(mint, pre.path);
    recordDailySignal(symbol);

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

    const [tokenBal, overview] = await Promise.all([getTokenBalance(mint), getTokenOverview(mint)]);
    positions.set(mint, { mint, symbol, entryPrice: currentPrice, usdtSpent: buyAmount, tokenBalance: tokenBal, decimals: overview.decimals, batchesSold: new Set(), boughtAt: Math.floor(Date.now() / 1000) });
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
    recordDailyTrade(usdtSpent * pnlPct / 100);
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
      recordDailyTrade(realized - cost);
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

async function runCycle(): Promise<void> {
  const tokens = getActiveTokens();

  if (tokens.length === 0) {
    log('WARN', '━━━ No active tokens in watchlist — skipping cycle ━━━');
    return;
  }

  log('INFO', `━━━ Cycle start | ${tokens.length} tokens | DRY_RUN=${config.dryRun} ━━━`);
  emit('bot:cycle', { phase: 'start', tokenCount: tokens.length, positionCount: positions.size });

  // Fetch wallet balances once per cycle (avoids repeated RPC calls per token)
  let solBalance  = 0;
  let usdtBalance = 0;
  try {
    [solBalance, usdtBalance] = await Promise.all([
      getSolBalance(),
      getTokenBalance(USDT_MINT),
    ]);
    emit('bot:balance', { solBalance, usdtBalance });
    log('INFO', `[Wallet] SOL: ${solBalance.toFixed(4)} | USDT: $${usdtBalance.toFixed(2)}`);
  } catch (err) {
    log('WARN', `[Wallet] Balance fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const token of tokens) {
    await scanToken(token, solBalance, usdtBalance);
    await sleep(1200);
  }

  emit('bot:cycle', { phase: 'complete', tokenCount: tokens.length, positionCount: positions.size });
  log('INFO', `━━━ Cycle complete | open positions: ${positions.size} ━━━\n`);
}

export async function startMonitor(): Promise<void> {
  const initial = getActiveTokens();
  log('INFO', `Monitor started — watching ${initial.map((t) => t.symbol).join(', ')} (${initial.length} active)`);
  log('INFO', `Interval: ${config.monitorIntervalSec}s | Max buy: $${config.maxBuyUsdt} USDT | DRY_RUN: ${config.dryRun}`);
  log('INFO', `Risk: stop-loss ${config.stopLossPct}% | max positions ${config.maxOpenPositions} | daily loss cap $${config.maxDailyLossUsdt}`);

  emit('bot:status', { running: true, dryRun: config.dryRun, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });

  await runCycle();

  setInterval(async () => {
    emit('bot:status', { running: true, dryRun: config.dryRun, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
    try {
      await runCycle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('ERROR', `Cycle failed: ${msg}`);
    }
  }, config.monitorIntervalSec * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
