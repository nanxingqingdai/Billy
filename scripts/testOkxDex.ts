/**
 * OKX DEX API 连通性 & 行情测试
 *
 * Usage:
 *   npx ts-node scripts/testOkxDex.ts [mint1] [mint2] ...
 *
 * 不传 mint 时，仅测试连通性（获取 token 列表）。
 * 传入 mint 时，额外测试价格推导并与 Birdeye / DexScreener 交叉验证。
 *
 * Example:
 *   npx ts-node scripts/testOkxDex.ts AGdGTQa8iRnSx4fQJehWo4Xwbh1bzTazs55R6Jwupump
 */

import 'dotenv/config';
import {
  isOkxConfigured,
  getSupportedTokens,
  getOkxSwapQuote,
  getOkxTokenPrice,
} from '../src/services/okxDex';
import { getTokenOverview } from '../src/services/birdeye';
import { getDexScreenerSummary } from '../src/services/dexscreener';

const SEP  = '─'.repeat(68);
const USD  = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
const PCT  = (n: number) => `${n.toFixed(2)}%`;

// ─── Step 1: 认证配置检查 ──────────────────────────────────────────────────

function checkConfig(): void {
  console.log('\n[1] 认证配置检查');
  console.log(SEP);
  const vars = ['OKX_PROJECT_ID', 'OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE'];
  for (const v of vars) {
    const val = process.env[v];
    console.log(`  ${v.padEnd(20)}: ${val ? '✅ 已设置' : '❌ 未设置'}`);
  }
  if (!isOkxConfigured()) {
    console.error('\n❌ 缺少必要环境变量，请检查 .env');
    process.exit(1);
  }
  console.log('\n  ✅ 所有凭证已配置');
}

// ─── Step 2: 连通性测试（获取支持的代币列表） ─────────────────────────────

async function testConnectivity(): Promise<void> {
  console.log('\n[2] 连通性测试 — GET /api/v5/dex/aggregator/all-tokens');
  console.log(SEP);
  try {
    const tokens = await getSupportedTokens();
    console.log(`  ✅ 请求成功，Solana 支持的代币数量: ${tokens.length}`);

    // 展示前 5 个
    console.log('\n  前 5 个代币:');
    for (const t of tokens.slice(0, 5)) {
      console.log(`    ${t.tokenSymbol.padEnd(12)} ${t.tokenContractAddress}  decimals=${t.decimals}`);
    }

    // 搜索几个知名代币确认数据质量
    const known = ['SOL', 'USDC', 'BONK', 'WIF'];
    console.log('\n  已知代币搜索:');
    for (const sym of known) {
      const found = tokens.find((t) => t.tokenSymbol.toUpperCase() === sym);
      console.log(`    ${sym.padEnd(6)}: ${found ? `✅ 找到 (${found.tokenContractAddress})` : '⚠️  未找到'}`);
    }
  } catch (err) {
    console.error(`  ❌ 连通性测试失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ─── Step 3: 单个代币价格测试 + 三方对比 ──────────────────────────────────

async function testTokenPrice(mint: string): Promise<void> {
  console.log(`\n[3] 代币价格测试: ${mint}`);
  console.log(SEP);

  // OKX 报价
  let okxPrice: Awaited<ReturnType<typeof getOkxTokenPrice>> | null = null;
  console.log('\n  ─ OKX DEX (1 USDC → token quote)');
  try {
    // 先用 Birdeye 获取 decimals
    const overview = await getTokenOverview(mint);
    console.log(`  代币: ${overview.symbol} (decimals=${overview.decimals})`);

    okxPrice = await getOkxTokenPrice(mint, overview.decimals);
    console.log(`  OKX 价格 (推导)  : ${USD(okxPrice.priceUsd)}`);
    console.log(`  1 USDC 可买到    : ${(parseFloat(okxPrice.outputTokenRaw) / Math.pow(10, okxPrice.decimals)).toFixed(2)} ${overview.symbol}`);

    // 完整 quote 原始数据
    console.log('\n  完整 quote 原始响应:');
    const raw = await getOkxSwapQuote({
      fromTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      toTokenAddress:   mint,
      amount:           '1000000',
    });
    console.log(`    fromTokenAmount : ${raw.fromTokenAmount}`);
    console.log(`    toTokenAmount   : ${raw.toTokenAmount}`);
    console.log(`    priceImpactPct  : ${PCT(raw.priceImpactPct)}`);
    console.log(`    estimatedGas    : ${raw.estimatedGas}`);
    console.log(`    rawResponse     :`);
    console.log(JSON.stringify(raw.rawResponse, null, 6).split('\n').map((l) => '      ' + l).join('\n'));

    // 三方对比
    console.log('\n  ─ 三方价格对比');
    const birdeyePrice = overview.price;

    let dsPrice: number | null = null;
    try {
      const ds = await getDexScreenerSummary(mint);
      dsPrice = ds.priceUsd;
    } catch {
      console.log('  DexScreener: 请求失败，跳过');
    }

    const bVsOkx = okxPrice.priceUsd > 0
      ? Math.abs(birdeyePrice - okxPrice.priceUsd) / okxPrice.priceUsd * 100
      : NaN;
    const dsVsOkx = dsPrice && okxPrice.priceUsd > 0
      ? Math.abs(dsPrice - okxPrice.priceUsd) / okxPrice.priceUsd * 100
      : NaN;

    console.log(`  ${'来源'.padEnd(14)} ${'价格'.padStart(20)} ${'vs OKX 差异'.padStart(14)}`);
    console.log(`  ${'-'.repeat(52)}`);
    console.log(`  ${'Birdeye'.padEnd(14)} ${USD(birdeyePrice).padStart(20)} ${isNaN(bVsOkx) ? '     N/A' : `${bVsOkx.toFixed(2)}%`.padStart(14)}  ${bVsOkx <= 5 ? '✅' : '⚠️'}`);
    if (dsPrice !== null) {
      console.log(`  ${'DexScreener'.padEnd(14)} ${USD(dsPrice).padStart(20)} ${isNaN(dsVsOkx) ? '     N/A' : `${dsVsOkx.toFixed(2)}%`.padStart(14)}  ${dsVsOkx <= 5 ? '✅' : '⚠️'}`);
    }
    console.log(`  ${'OKX DEX'.padEnd(14)} ${USD(okxPrice.priceUsd).padStart(20)} ${'(基准)'.padStart(14)}`);

  } catch (err) {
    console.error(`  ❌ 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(68));
  console.log('  OKX DEX API 测试');
  console.log('═'.repeat(68));

  checkConfig();
  await testConnectivity();

  const mints = process.argv.slice(2);
  if (mints.length > 0) {
    for (const mint of mints) {
      await testTokenPrice(mint);
      if (mints.indexOf(mint) < mints.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } else {
    console.log('\n  ℹ️  未传入 mint 地址，仅测试连通性。');
    console.log('  传入 mint 地址可测试价格推导，例如:');
    console.log('  npx ts-node scripts/testOkxDex.ts AGdGTQa8iRnSx4fQJehWo4Xwbh1bzTazs55R6Jwupump');
  }

  console.log(`\n${'═'.repeat(68)}\n  完成\n${'═'.repeat(68)}\n`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
