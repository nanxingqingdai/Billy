/**
 * Usage:
 *   npx ts-node scripts/testPreConditions.ts <mint1> [mint2] [mint3] ...
 *
 * Example:
 *   npx ts-node scripts/testPreConditions.ts EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm
 *
 * Prints all raw API values + computed fields so you can verify the logic by eye.
 */

import 'dotenv/config';
import {
  getTokenOverview,
  getRecentOHLCV,
  candleAmplitude,
  checkEntryPreConditions,
} from '../src/services/birdeye';
import { getDexScreenerSummary, crossValidate } from '../src/services/dexscreener';

// ─── Formatting helpers ────────────────────────────────────────────────────

const USD  = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const PCT  = (n: number) => `${n.toFixed(2)}%`;
const BOOL = (b: boolean) => b ? '✅ YES' : '❌ NO';
const SEP  = '─'.repeat(70);

// ─── Single-token diagnostic ───────────────────────────────────────────────

async function diagnose(mint: string): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  MINT: ${mint}`);
  console.log('═'.repeat(70));

  // ── 1. Raw token overview ────────────────────────────────────────────────
  console.log('\n[1] TOKEN OVERVIEW (raw)');
  console.log(SEP);
  let overview: Awaited<ReturnType<typeof getTokenOverview>>;
  try {
    overview = await getTokenOverview(mint);
    console.log(`  symbol          : ${overview.symbol}`);
    console.log(`  name            : ${overview.name}`);
    console.log(`  decimals        : ${overview.decimals}`);
    console.log(`  price           : ${overview.price}`);
    console.log(`  priceChange24h  : ${PCT(overview.priceChange24hPercent ?? 0)}`);
    console.log(`  marketCap       : ${USD(overview.marketCap)}`);
    console.log(`  liquidity       : ${USD(overview.liquidity)}`);
    console.log(`  v24hUSD         : ${USD(overview.v24hUSD)}`);
    console.log(`  trade24h        : ${overview.trade24h}`);
    console.log(`  holder          : ${overview.holder}`);
  } catch (err) {
    console.error(`  ❌ getTokenOverview failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── 2. Raw daily candles (last 15 shown) ─────────────────────────────────
  console.log('\n[2] DAILY CANDLES — last 15 (of up to 401 fetched)');
  console.log(SEP);
  let dailyCandles: Awaited<ReturnType<typeof getRecentOHLCV>>;
  try {
    dailyCandles = await getRecentOHLCV(mint, '1D', 401);
    console.log(`  Total fetched   : ${dailyCandles.length} candles`);

    if (dailyCandles.length > 0) {
      const first = dailyCandles[0]!;
      const last  = dailyCandles[dailyCandles.length - 1]!;
      const ageDays = (Date.now() / 1000 - first.unixTime) / 86400;
      console.log(`  First candle    : ${new Date(first.unixTime * 1000).toISOString().slice(0, 10)}`);
      console.log(`  Last candle     : ${new Date(last.unixTime * 1000).toISOString().slice(0, 10)}`);
      console.log(`  Estimated age   : ${ageDays.toFixed(1)} days`);

      // Estimated supply & ATH
      const estimatedSupply = overview.price > 0 ? overview.marketCap / overview.price : 0;
      const athPrice        = dailyCandles.reduce((m, c) => Math.max(m, c.h), 0);
      const athMarketCap    = athPrice * estimatedSupply;
      const drawdownPct     = athMarketCap > 0
        ? ((athMarketCap - overview.marketCap) / athMarketCap) * 100
        : 0;
      console.log(`  Est. supply     : ${estimatedSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
      console.log(`  ATH price       : ${athPrice}`);
      console.log(`  ATH market cap  : ${USD(athMarketCap)}`);
      console.log(`  Current MC      : ${USD(overview.marketCap)}`);
      console.log(`  Drawdown        : ${PCT(drawdownPct)}`);

      // Last 10 completed daily candles table
      const window10 = dailyCandles.slice(-11, -1);
      console.log(`\n  Last 10 completed daily candles:`);
      console.log(`  ${'Date'.padEnd(12)} ${'Open'.padStart(12)} ${'High'.padStart(12)} ${'Low'.padStart(12)} ${'Close'.padStart(12)} ${'Vol(USD)'.padStart(14)} ${'Amp%'.padStart(8)}`);
      console.log(`  ${'-'.repeat(84)}`);
      for (const c of window10) {
        const date = new Date(c.unixTime * 1000).toISOString().slice(0, 10);
        const amp     = candleAmplitude(c);
        const volUsd  = c.v * c.c;   // c.v is token units → convert to USD
        const ampFlag = amp <= 15 ? ' ≤15%✓' : '';
        const volFlag = volUsd < 10_000 ? ' <10k✓' : volUsd < 20_000 ? ' <20k✓' : '';
        console.log(`  ${date.padEnd(12)} ${c.o.toFixed(6).padStart(12)} ${c.h.toFixed(6).padStart(12)} ${c.l.toFixed(6).padStart(12)} ${c.c.toFixed(6).padStart(12)} ${volUsd.toFixed(0).padStart(14)} ${(amp.toFixed(2) + '%').padStart(8)}${ampFlag}${volFlag}`);
      }
    }
  } catch (err) {
    console.error(`  ❌ getRecentOHLCV(1D) failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── 3. Raw 4H candles (last 10 shown) ────────────────────────────────────
  console.log('\n[3] 4H CANDLES — last 11 fetched (last 10 completed shown)');
  console.log(SEP);
  try {
    const candles4h = await getRecentOHLCV(mint, '4H', 11);
    const window4h  = candles4h.slice(-11, -1);
    console.log(`  Total fetched   : ${candles4h.length} bars`);
    console.log(`\n  ${'Timestamp'.padEnd(20)} ${'Open'.padStart(12)} ${'High'.padStart(12)} ${'Low'.padStart(12)} ${'Close'.padStart(12)} ${'Vol(USD)'.padStart(14)} ${'Amp%'.padStart(8)}`);
    console.log(`  ${'-'.repeat(94)}`);
    for (const c of window4h) {
      const ts  = new Date(c.unixTime * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const amp    = candleAmplitude(c);
      const volUsd = c.v * c.c;   // c.v is token units → convert to USD
      const ampFlag = amp < 10 ? ' <10%✓' : amp < 20 ? ' <20%✓' : '';
      const volFlag = volUsd < 10_000 ? ' <10k✓' : volUsd < 50_000 ? ' <50k✓' : '';
      console.log(`  ${ts.padEnd(20)} ${c.o.toFixed(8).padStart(12)} ${c.h.toFixed(8).padStart(12)} ${c.l.toFixed(8).padStart(12)} ${c.c.toFixed(8).padStart(12)} ${volUsd.toFixed(0).padStart(14)} ${(amp.toFixed(2) + '%').padStart(8)}${ampFlag}${volFlag}`);
    }
  } catch (err) {
    console.error(`  ❌ getRecentOHLCV(4H) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 4. checkEntryPreConditions result ────────────────────────────────────
  console.log('\n[4] checkEntryPreConditions() RESULT');
  console.log(SEP);
  try {
    const result = await checkEntryPreConditions(mint);
    console.log(`  passed          : ${BOOL(result.passed)}`);
    console.log(`  reason          : ${result.reason}`);
    console.log(`  athMarketCap    : ${USD(result.athMarketCapUsd)}`);
    console.log(`  currentMC       : ${USD(result.currentMarketCapUsd)}`);
    console.log(`  drawdownPct     : ${PCT(result.drawdownPct)}`);
    console.log(`  ageDays         : ${result.ageDays.toFixed(1)}`);
    console.log(`  lowAmpBars      : ${result.lowAmpBars}`);
    console.log(`  lowVolBars      : ${result.lowVolBars}`);
    console.log(`  volThreshold    : ${USD(result.volThresholdUsd)}`);
  } catch (err) {
    console.error(`  ❌ checkEntryPreConditions failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 5. DexScreener 交叉验证 ───────────────────────────────────────────────
  console.log('\n[5] DEXSCREENER 交叉验证');
  console.log(SEP);
  try {
    const ds = await getDexScreenerSummary(mint);

    console.log(`  有效交易对数量  : ${ds.pairs.length}`);
    console.log(`  价格 (DexScrn)  : $${ds.priceUsd.toFixed(8)}`);
    console.log(`  24h 成交量      : ${USD(ds.totalVolume24h)}`);
    console.log(`  总流动性        : ${USD(ds.totalLiquidityUsd)}`);
    console.log(`  市值 (DexScrn)  : ${USD(ds.marketCap)}`);
    console.log(`  代币年龄 (精确) : ${ds.ageDays.toFixed(1)} 天`);
    console.log(`  最早交易对创建  : ${ds.earliestPairCreatedMs > 0 ? new Date(ds.earliestPairCreatedMs).toISOString().slice(0, 10) : 'N/A'}`);

    // 各交易对明细
    console.log(`\n  交易对明细 (流动性从高到低):`);
    const sorted = [...ds.pairs].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    for (const p of sorted) {
      console.log(`    ${p.dexId.padEnd(12)} liq=${USD(p.liquidityUsd).padStart(12)}  vol24h=${USD(p.volume.h24).padStart(12)}  price=$${p.priceUsd.toFixed(8)}`);
    }

    // 与 Birdeye 数据对比
    console.log(`\n  对比 Birdeye 数据:`);
    const validation = crossValidate(overview.price, overview.v24hUSD, ds);
    console.log(`  价格差异        : ${validation.priceDiffPct.toFixed(2)}%  ${validation.priceMatch  ? '✅' : '⚠️ 偏差过大'}`);
    console.log(`  成交量差异      : ${validation.volumeDiffPct.toFixed(2)}%  ${validation.volumeMatch ? '✅' : '⚠️ 偏差过大'}`);
    console.log(`  年龄 (Birdeye)  : ${overview ? '见[2]段' : 'N/A'}  |  年龄 (DexScrn): ${ds.ageDays.toFixed(1)} 天`);
    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) console.log(`  ⚠️  ${w}`);
    }
  } catch (err) {
    console.error(`  ❌ DexScreener 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mints = process.argv.slice(2);
  if (mints.length === 0) {
    console.error('Usage: npx ts-node scripts/testPreConditions.ts <mint1> [mint2] ...');
    process.exit(1);
  }

  for (const mint of mints) {
    await diagnose(mint);
    // Small delay between tokens to avoid rate-limiting
    if (mints.indexOf(mint) < mints.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.log(`\n${'═'.repeat(70)}\n  Done.\n${'═'.repeat(70)}\n`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
