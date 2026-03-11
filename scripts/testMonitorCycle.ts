/**
 * Monitor 链路集成测试
 *
 * 模拟 scanToken 的完整执行路径（dry run），验证各模块正确连接：
 *   checkEntryPreConditions → isLowVolContraction → getQuote → runBuyChecks → buyWithUsdt(dryRun)
 *
 * 用法：
 *   node --env-file=.env -r ts-node/register scripts/testMonitorCycle.ts
 *   node --env-file=.env -r ts-node/register scripts/testMonitorCycle.ts <MINT>
 */
import 'dotenv/config';
import { getRecentOHLCV, getTokenPrice, isLowVolContraction, checkEntryPreConditions, getTokenOverview } from '../src/services/birdeye';
import { getQuote, buyWithUsdt, getSolBalance, getTokenBalance, toRawAmount, USDT_MINT, USDT_DECIMALS } from '../src/services/jupiter';
import { runBuyChecks } from '../src/strategies/riskManager';
import { getActiveTokens } from '../src/config/watchlist';
import { config } from '../src/config/env';

const FORCED_MINT = process.argv[2]; // optional: override watchlist

function sep(label: string) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(50));
}

function ok(label: string, value: unknown) {
  console.log(`  ✅ ${label}: ${value}`);
}

function warn(label: string, value: unknown) {
  console.log(`  ⚠️  ${label}: ${value}`);
}

function fail(label: string, value: unknown) {
  console.log(`  ❌ ${label}: ${value}`);
}

async function runTest() {
  // ── 选 token ──────────────────────────────────────────────────────────────
  sep('Step 0 — 选取测试代币');
  let token = getActiveTokens()[0];

  if (FORCED_MINT) {
    // 用命令行传入的 mint 构造最小配置
    token = {
      symbol: 'TEST',
      name:   'Test Token',
      mint:   FORCED_MINT,
      active: true,
      maxBuyUsdt:  config.maxBuyUsdt,
      slippageBps: config.slippageBps,
      signal: { interval: '4H', lookback: 5, maxAmplitudePct: 5, volumeContractionRatio: 0.7 },
      sellBatches: [{ priceMultiplier: 1.5, portion: 1.0 }],
    };
    console.log(`  使用命令行 mint: ${FORCED_MINT}`);
  } else if (!token) {
    console.error('  watchlist.json 中没有 active 代币，请传入 mint 参数');
    process.exit(1);
  } else {
    console.log(`  使用 watchlist 第一个 active 代币: ${token.symbol} (${token.mint})`);
  }

  const { symbol, mint, signal, maxBuyUsdt, slippageBps } = token;

  // ── 钱包余额 ──────────────────────────────────────────────────────────────
  sep('Step 1 — 钱包余额');
  let solBalance = 0, usdtBalance = 0;
  try {
    [solBalance, usdtBalance] = await Promise.all([getSolBalance(), getTokenBalance(USDT_MINT)]);
    ok('SOL', `${solBalance.toFixed(4)} SOL`);
    ok('USDT', `$${usdtBalance.toFixed(2)}`);
  } catch (e) {
    warn('余额获取失败（RPC 问题？）', e instanceof Error ? e.message : String(e));
  }

  // ── 实时价格 ──────────────────────────────────────────────────────────────
  sep('Step 2 — Birdeye 实时价格');
  const priceData = await getTokenPrice(mint);
  ok('Price', `$${priceData.value.toFixed(8)}`);
  ok('24h change', `${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h?.toFixed(2) ?? '?'}%`);

  // ── Token Overview（decimals）─────────────────────────────────────────────
  sep('Step 3 — Token Overview (decimals)');
  const overview = await getTokenOverview(mint);
  ok('Symbol', overview.symbol);
  ok('Decimals', overview.decimals);
  ok('Market Cap', `$${overview.marketCap.toLocaleString()}`);
  if (overview.decimals === 0) {
    warn('decimals=0', '如果这不是 SOL/WSOL，可能是数据问题');
  }

  // ── Entry pre-conditions ──────────────────────────────────────────────────
  sep('Step 4 — checkEntryPreConditions');
  const pre = await checkEntryPreConditions(mint);
  console.log(`  Path     : ${pre.path}`);
  console.log(`  ATH MC   : $${pre.athMarketCapUsd.toLocaleString()}`);
  console.log(`  Drawdown : ${pre.drawdownPct.toFixed(2)}%`);
  console.log(`  AmpBars  : ${pre.lowAmpBars}`);
  console.log(`  VolBars  : ${pre.lowVolBars}  (threshold $${pre.volThresholdUsd.toLocaleString()})`);
  console.log(`  Age      : ${pre.ageDays.toFixed(1)} days`);
  if (pre.passed) {
    ok('pre-conditions', 'PASSED — ' + pre.reason);
  } else {
    warn('pre-conditions', 'BLOCKED — ' + pre.reason);
    console.log('\n  （pre-conditions 未通过，后续步骤仍继续验证链路连通性）');
  }

  // ── isLowVolContraction 信号 ───────────────────────────────────────────────
  sep('Step 5 — isLowVolContraction 信号');
  const candles = await getRecentOHLCV(mint, signal.interval, signal.lookback + 5);
  console.log(`  拉取 ${candles.length} 根 ${signal.interval} K线（需要 ≥ ${signal.lookback + 1}）`);
  if (candles.length < signal.lookback + 1) {
    warn('K线不足', '跳过信号检测');
  } else {
    const triggered = isLowVolContraction(candles, {
      lookback: signal.lookback,
      maxAmplitudePct: signal.maxAmplitudePct,
      volumeContractionRatio: signal.volumeContractionRatio,
    });
    (triggered ? ok : warn)('信号', triggered ? 'TRIGGERED 🔔' : '未触发');
  }

  // ── Jupiter 报价 ──────────────────────────────────────────────────────────
  sep('Step 6 — Jupiter getQuote');
  const buyAmount = Math.min(maxBuyUsdt, config.maxBuyUsdt);
  const rawAmount = Math.floor(buyAmount * Math.pow(10, USDT_DECIMALS));
  console.log(`  买入金额 : $${buyAmount} USDT`);
  const quote = await getQuote({ inputMint: USDT_MINT, outputMint: mint, amount: rawAmount, slippageBps });
  ok('inAmount',      `${quote.inAmount} raw USDT`);
  ok('outAmount',     `${quote.outAmount} raw tokens`);
  ok('priceImpact',   `${parseFloat(quote.priceImpactPct).toFixed(4)}%`);
  ok('slippageBps',   quote.slippageBps);
  ok('routePlan steps', quote.routePlan.length);

  // ── 风控检查 ──────────────────────────────────────────────────────────────
  sep('Step 7 — runBuyChecks (风控)');
  const riskResult = runBuyChecks(symbol, 0, usdtBalance, solBalance, buyAmount, quote);
  console.log(`  Daily loss   : $0 (test baseline)`);
  console.log(`  Open positions: 0`);
  console.log(`  SOL balance  : ${solBalance.toFixed(4)}`);
  console.log(`  USDT balance : $${usdtBalance.toFixed(2)}`);
  console.log(`  Buy amount   : $${buyAmount}`);
  if (riskResult.ok) {
    ok('risk gate', `ALL PASSED`);
  } else {
    warn('risk gate', `BLOCKED by ${riskResult.rule}: ${riskResult.detail}`);
  }

  // ── toRawAmount 正确性验证 ─────────────────────────────────────────────────
  sep('Step 8 — toRawAmount decimals 验证');
  const testUiAmount = 1.0;
  const rawForSell = toRawAmount(testUiAmount, overview.decimals);
  ok('toRawAmount(1.0 token)', `${rawForSell} raw units  (decimals=${overview.decimals})`);
  if (rawForSell < 10 && overview.decimals > 0) {
    fail('decimals 异常', 'raw amount 过小，卖出会失败');
  }

  // ── Dry-run 买入 ──────────────────────────────────────────────────────────
  sep('Step 9 — buyWithUsdt (DRY RUN)');
  const swapResult = await buyWithUsdt(mint, buyAmount, slippageBps, /* dryRun= */ true);
  ok('txid',     swapResult.txid);
  ok('inAmount', swapResult.inAmount);
  ok('outAmount',swapResult.outAmount);

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  sep('结果汇总');
  console.log(`  代币          : ${symbol} (${mint})`);
  console.log(`  Pre-conditions: ${pre.passed ? '✅ PASSED' : '⚠️  BLOCKED'}`);
  console.log(`  Jupiter 报价  : ✅ OK`);
  console.log(`  风控检查      : ${riskResult.ok ? '✅ ALL PASSED' : `⚠️  ${riskResult.rule}`}`);
  console.log(`  Dry-run 买入  : ✅ OK`);
  console.log(`  Decimals      : ${overview.decimals} ✅`);
  console.log(`\n  全链路连通性验证完成 ✅`);
}

runTest().catch(e => {
  console.error('\n[FATAL]', e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
