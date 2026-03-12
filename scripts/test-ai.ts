/**
 * AI 功能测试脚本
 * 运行: npx ts-node scripts/test-ai.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { isGeminiConfigured, generateSignalAnalysis, screenToken, generateDailySummary, answerQuery } from '../src/services/gemini';
import { isKimiConfigured, getTokenCommentary, getSignalSecondOpinion } from '../src/services/kimi';
import { recordDailySignal, recordDailyTrade } from '../src/services/dailySummary';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

function ok(label: string, val: string) {
  console.log(`${GREEN}✅ ${label}${RESET}`);
  console.log(`   ${CYAN}→ ${val.slice(0, 120)}${val.length > 120 ? '…' : ''}${RESET}\n`);
}
function fail(label: string, err: unknown) {
  console.log(`${RED}❌ ${label}${RESET}`);
  console.log(`   ${RED}→ ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
}
function info(msg: string) {
  console.log(`${YELLOW}${msg}${RESET}`);
}

// ── 虚拟信号数据（WIF 作为示例）────────────────────────────────────────────

const SAMPLE_SIGNAL = {
  symbol:          'WIF',
  mint:            'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  athMarketCapUsd: 4_800_000_000,
  drawdownPct:     87.5,
  ageDays:         420,
  lowAmpBars:      5,
  lowVolBars:      4,
  priceImpactPct:  0.8,
  marketCapStr:    '$600M',
  change24hStr:    '-2.3%',
  path:            'mature' as const,
};

async function main() {
  console.log('\n========================================');
  console.log('  BillyCode AI 功能测试');
  console.log('========================================\n');

  // ── 1. 配置检查 ─────────────────────────────────────────────────────────
  info('【配置检查】');
  console.log(`  Gemini: ${isGeminiConfigured() ? `${GREEN}✅ 已配置${RESET}` : `${RED}❌ 未配置 (GOOGLE_AI_API_KEY)${RESET}`}`);
  console.log(`  Kimi:   ${isKimiConfigured()   ? `${GREEN}✅ 已配置${RESET}` : `${RED}❌ 未配置 (KIMI_API_KEY)${RESET}`}\n`);

  // ── 2. Gemini 测试 ───────────────────────────────────────────────────────
  if (isGeminiConfigured()) {
    info('【Gemini 功能测试】');

    // Feature 1: 信号分析
    try {
      const result = await generateSignalAnalysis(SAMPLE_SIGNAL);
      ok('Feature 1 — 信号分析', result);
    } catch (e) { fail('Feature 1 — 信号分析', e); }

    // Feature 3: 代币筛查
    try {
      const result = await screenToken(SAMPLE_SIGNAL);
      ok(`Feature 3 — 代币筛查 (${result.pass ? 'PASS' : 'FAIL'})`, result.reason);
    } catch (e) { fail('Feature 3 — 代币筛查', e); }

    // Feature 2: 日报生成（模拟数据）
    try {
      recordDailySignal('WIF');
      recordDailySignal('BONK');
      recordDailyTrade(12.5);
      recordDailyTrade(-5.2);
      const result = await generateDailySummary({
        date:          '2026-03-12',
        signalCount:   2,
        tradeCount:    2,
        totalPnlUsdt:  7.3,
        winCount:      1,
        lossCount:     1,
        openPositions: 1,
        topSignals:    ['WIF', 'BONK'],
        watchlistCount: 5,
      });
      ok('Feature 2 — 每日日报生成', result);
    } catch (e) { fail('Feature 2 — 每日日报生成', e); }

    // Feature 4: Dashboard 问答
    try {
      const context = `运行状态: 运行中 | DryRun: true | 运行时长: 120 分钟
SOL余额: 0.25 SOL | USDT余额: $142.50
当前持仓 (1 个):
  - WIF: 开仓价 $0.123456，当前盈亏 +5.2%
监控代币: WIF, BONK, POPCAT (3 个)
风控参数: 单笔最大买入 $50 | 止损 20% | 最大持仓 3 个`;
      const result = await answerQuery('我现在的持仓盈亏情况怎么样？', context);
      ok('Feature 4 — Dashboard 问答', result);
    } catch (e) { fail('Feature 4 — Dashboard 问答', e); }

  } else {
    console.log(`${YELLOW}⚠  跳过 Gemini 测试（未配置）${RESET}\n`);
  }

  // ── 3. Kimi 测试 ────────────────────────────────────────────────────────
  if (isKimiConfigured()) {
    info('【Kimi 功能测试】');

    // 行情解读
    try {
      const result = await getTokenCommentary({
        symbol:      'WIF',
        price:       0.6234,
        change24h:   -2.3,
        hasPosition: true,
        entryPrice:  0.5900,
        pnlPct:      5.66,
      });
      ok('Kimi — 行情解读（有持仓）', result);
    } catch (e) { fail('Kimi — 行情解读', e); }

    // 行情解读（无持仓）
    try {
      const result = await getTokenCommentary({
        symbol:    'BONK',
        price:     0.000025,
        change24h: 8.7,
        hasPosition: false,
      });
      ok('Kimi — 行情解读（无持仓）', result);
    } catch (e) { fail('Kimi — 行情解读（无持仓）', e); }

    // 信号第二视角
    try {
      const result = await getSignalSecondOpinion(SAMPLE_SIGNAL);
      ok('Kimi — 信号第二视角', result);
    } catch (e) { fail('Kimi — 信号第二视角', e); }

  } else {
    console.log(`${YELLOW}⚠  跳过 Kimi 测试（未配置）${RESET}\n`);
  }

  console.log('========================================');
  console.log('  测试完成');
  console.log('========================================\n');
}

main().catch(err => {
  console.error(RED + '[FATAL]' + RESET, err);
  process.exit(1);
});
