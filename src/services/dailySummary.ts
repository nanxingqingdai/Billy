/**
 * 每日总结推送服务
 * - 收集当日信号/交易/盈亏数据
 * - UTC 00:00 生成日报并推送到 Telegram
 */

import { log } from '../utils/logger';
import { isGeminiConfigured, generateDailySummary } from './gemini';
import { isTelegramConfigured, sendTelegramMessage } from './telegramNotifier';
import { getActiveTokens } from '../config/watchlist';
import { loadPositions } from '../utils/positionStore';

// ─── Daily state ─────────────────────────────────────────────────────────────

interface DailyState {
  dateUtc:     string;
  signalCount: number;
  tradeCount:  number;
  pnlUsdt:     number;
  winCount:    number;
  lossCount:   number;
  signals:     string[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function newState(): DailyState {
  return {
    dateUtc:     todayUtc(),
    signalCount: 0,
    tradeCount:  0,
    pnlUsdt:     0,
    winCount:    0,
    lossCount:   0,
    signals:     [],
  };
}

let _state: DailyState = newState();

function ensureToday(): void {
  if (_state.dateUtc !== todayUtc()) _state = newState();
}

// ─── Public recorders ────────────────────────────────────────────────────────

/** Call when a valid buy signal is detected and notification sent. */
export function recordDailySignal(symbol: string): void {
  ensureToday();
  _state.signalCount++;
  if (!_state.signals.includes(symbol)) _state.signals.push(symbol);
}

/** Call when a trade (buy/sell batch/force-close) is executed with realized P&L. */
export function recordDailyTrade(pnlUsdt: number): void {
  ensureToday();
  _state.tradeCount++;
  _state.pnlUsdt += pnlUsdt;
  if (pnlUsdt >= 0) _state.winCount++; else _state.lossCount++;
}

// ─── Send daily summary ──────────────────────────────────────────────────────

async function sendDailySummary(): Promise<void> {
  if (!isTelegramConfigured()) {
    log('WARN', '[DailySummary] Telegram not configured, skipping daily summary');
    return;
  }

  ensureToday();
  const openPositions  = loadPositions().size;
  const watchlistCount = getActiveTokens().length;

  const pnlSign = _state.pnlUsdt >= 0 ? '+' : '';

  let text = [
    `📊 <b>BillyCode 每日日报 — ${_state.dateUtc}</b>`,
    ``,
    `🔔 信号触发: <b>${_state.signalCount}</b> 次`,
    `💼 实际交易: <b>${_state.tradeCount}</b> 次`,
    `💰 总盈亏: <b>${pnlSign}$${_state.pnlUsdt.toFixed(2)} USDT</b>`,
    `  ✅ 盈利: ${_state.winCount} 笔  |  ❌ 亏损: ${_state.lossCount} 笔`,
    `📦 当前持仓: ${openPositions} 个`,
    `👀 监控代币: ${watchlistCount} 个`,
    _state.signals.length > 0 ? `📈 信号代币: ${_state.signals.slice(0, 6).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  if (isGeminiConfigured()) {
    log('INFO', '[DailySummary] Generating AI analysis...');
    const analysis = await generateDailySummary({
      date:          _state.dateUtc,
      signalCount:   _state.signalCount,
      tradeCount:    _state.tradeCount,
      totalPnlUsdt:  _state.pnlUsdt,
      winCount:      _state.winCount,
      lossCount:     _state.lossCount,
      openPositions,
      topSignals:    _state.signals.slice(0, 6),
      watchlistCount,
    });
    if (analysis) {
      text += `\n\n🤖 <b>AI 分析</b>\n${analysis}`;
    }
  }

  await sendTelegramMessage(text);
  log('INFO', `[DailySummary] Daily summary sent for ${_state.dateUtc}`);

  // Reset state for the next day
  _state = newState();
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let _lastSentDate = '';

/** Start the daily summary scheduler. Fires at UTC 00:00 every day. */
export function startDailySummaryScheduler(): void {
  log('INFO', '[DailySummary] Scheduler started (fires at UTC 00:00)');

  setInterval(async () => {
    const now   = new Date();
    const hh    = now.getUTCHours();
    const mm    = now.getUTCMinutes();
    const today = todayUtc();

    // Fire in the first minute of UTC midnight, once per day
    if (hh === 0 && mm === 0 && _lastSentDate !== today) {
      _lastSentDate = today;
      try {
        await sendDailySummary();
      } catch (err) {
        log('ERROR', `[DailySummary] Failed to send: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 60_000);
}
