import { getRiskConfig } from '../config/riskConfig';
import { emit } from '../utils/emitter';
import { log } from '../utils/logger';
import type { QuoteResponse } from '../services/jupiter';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RiskCheckResult {
  ok: boolean;
  rule: string;
  detail: string;
}

export interface PositionSnapshot {
  mint: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  usdtSpent: number;
  boughtAt: number; // unix seconds
}

// ─── Daily loss tracker ────────────────────────────────────────────────────

interface DailyLoss {
  dateUtc: string;   // YYYY-MM-DD
  lossUsdt: number;
}

let _dailyLoss: DailyLoss = { dateUtc: todayUtc(), lossUsdt: 0 };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record a realised loss (positive value = loss). Auto-resets at UTC midnight. */
export function recordLoss(lossUsdt: number): void {
  if (todayUtc() !== _dailyLoss.dateUtc) {
    _dailyLoss = { dateUtc: todayUtc(), lossUsdt: 0 };
  }
  _dailyLoss.lossUsdt += lossUsdt;
  log('INFO', `[Risk] Daily loss updated: $${_dailyLoss.lossUsdt.toFixed(2)} / $${getRiskConfig().maxDailyLossUsdt}`);
}

export function getDailyLoss(): number {
  if (todayUtc() !== _dailyLoss.dateUtc) {
    _dailyLoss = { dateUtc: todayUtc(), lossUsdt: 0 };
  }
  return _dailyLoss.lossUsdt;
}

// ─── Individual checks ─────────────────────────────────────────────────────

/**
 * Check 1 — Stop-loss
 * Fail if current price is more than STOP_LOSS_PCT% below entry.
 */
export function checkStopLoss(pos: PositionSnapshot): RiskCheckResult {
  const { stopLossPct } = getRiskConfig();
  const dropPct = ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;
  if (dropPct >= stopLossPct) {
    return {
      ok: false,
      rule: 'STOP_LOSS',
      detail: `${pos.symbol} dropped ${dropPct.toFixed(2)}% from entry (limit: ${stopLossPct}%)`,
    };
  }
  return { ok: true, rule: 'STOP_LOSS', detail: `drop ${dropPct.toFixed(2)}% — OK` };
}

/**
 * Check 2 — Max open positions
 * Fail if already holding MAX_OPEN_POSITIONS tokens.
 */
export function checkMaxPositions(currentCount: number): RiskCheckResult {
  const { maxOpenPositions } = getRiskConfig();
  if (currentCount >= maxOpenPositions) {
    return {
      ok: false,
      rule: 'MAX_POSITIONS',
      detail: `${currentCount} / ${maxOpenPositions} positions open — limit reached`,
    };
  }
  return { ok: true, rule: 'MAX_POSITIONS', detail: `${currentCount} / ${maxOpenPositions} — OK` };
}

/**
 * Check 3 — Daily loss limit
 * Fail if today's total realised loss exceeds MAX_DAILY_LOSS_USDT.
 */
export function checkDailyLoss(): RiskCheckResult {
  const { maxDailyLossUsdt } = getRiskConfig();
  const loss = getDailyLoss();
  if (loss >= maxDailyLossUsdt) {
    return {
      ok: false,
      rule: 'DAILY_LOSS',
      detail: `Daily loss $${loss.toFixed(2)} reached limit $${maxDailyLossUsdt} — buying paused`,
    };
  }
  return { ok: true, rule: 'DAILY_LOSS', detail: `$${loss.toFixed(2)} / $${maxDailyLossUsdt} — OK` };
}

/**
 * Check 4 — Max hold duration
 * Fail if a position has been open longer than MAX_HOLD_HOURS.
 */
export function checkHoldDuration(pos: PositionSnapshot): RiskCheckResult {
  const { maxHoldHours } = getRiskConfig();
  const heldHours = (Date.now() / 1000 - pos.boughtAt) / 3600;
  if (heldHours >= maxHoldHours) {
    return {
      ok: false,
      rule: 'MAX_HOLD',
      detail: `${pos.symbol} held ${heldHours.toFixed(1)}h — exceeds ${maxHoldHours}h limit`,
    };
  }
  return { ok: true, rule: 'MAX_HOLD', detail: `held ${heldHours.toFixed(1)}h / ${maxHoldHours}h — OK` };
}

/**
 * Check 5 — Price impact
 * Fail if Jupiter quote's price impact exceeds MAX_PRICE_IMPACT_PCT.
 */
export function checkPriceImpact(quote: QuoteResponse): RiskCheckResult {
  const { maxPriceImpactPct } = getRiskConfig();
  const impact = Math.abs(Number(quote.priceImpactPct));
  if (impact > maxPriceImpactPct) {
    return {
      ok: false,
      rule: 'PRICE_IMPACT',
      detail: `Price impact ${impact.toFixed(3)}% exceeds limit ${maxPriceImpactPct}%`,
    };
  }
  return { ok: true, rule: 'PRICE_IMPACT', detail: `impact ${impact.toFixed(3)}% — OK` };
}

/**
 * Check 6 — USDT balance reserve
 * Fail if buying buyAmount would leave wallet below MIN_USDT_RESERVE.
 */
export function checkBalance(usdtBalance: number, buyAmount: number): RiskCheckResult {
  const { minUsdtReserve } = getRiskConfig();
  const remaining = usdtBalance - buyAmount;
  if (remaining < minUsdtReserve) {
    return {
      ok: false,
      rule: 'MIN_RESERVE',
      detail: `Balance $${usdtBalance.toFixed(2)} - buy $${buyAmount.toFixed(2)} = $${remaining.toFixed(2)} < reserve $${minUsdtReserve}`,
    };
  }
  return { ok: true, rule: 'MIN_RESERVE', detail: `remaining $${remaining.toFixed(2)} ≥ reserve $${minUsdtReserve} — OK` };
}

// ─── Composite gate ────────────────────────────────────────────────────────

/** Run all pre-buy checks. Returns first failure, or ok if all pass. */
export function runBuyChecks(
  symbol: string,
  openPositions: number,
  usdtBalance: number,
  buyAmount: number,
  quote: QuoteResponse
): RiskCheckResult {
  const checks = [
    checkDailyLoss(),
    checkMaxPositions(openPositions),
    checkBalance(usdtBalance, buyAmount),
    checkPriceImpact(quote),
  ];

  for (const result of checks) {
    emitRisk(result, symbol);
    if (!result.ok) return result;
  }
  return { ok: true, rule: 'ALL_PASSED', detail: 'All buy checks passed' };
}

/** Run position-level risk checks (stop-loss + hold duration). Returns first failure. */
export function runPositionChecks(pos: PositionSnapshot): RiskCheckResult {
  const checks = [
    checkStopLoss(pos),
    checkHoldDuration(pos),
  ];

  for (const result of checks) {
    emitRisk(result, pos.symbol);
    if (!result.ok) return result;
  }
  return { ok: true, rule: 'ALL_PASSED', detail: 'Position checks passed' };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emitRisk(result: RiskCheckResult, symbol?: string): void {
  if (!result.ok) {
    log('WARN', `[Risk][${result.rule}] ${result.detail}`);
    emit('bot:risk', { rule: result.rule, symbol, detail: result.detail, blocked: true });
  }
}
