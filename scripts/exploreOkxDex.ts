/**
 * OKX DEX V6 API 全量探测脚本
 *
 * 对一个成熟代币（默认 SOL）逐一尝试所有已知 V6 端点，
 * 打印完整原始响应，摸清 OKX 能提供哪些行情数据。
 *
 * Usage:
 *   npx ts-node scripts/exploreOkxDex.ts
 */

import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';

// ─── 配置 ──────────────────────────────────────────────────────────────────

const BASE_URL     = 'https://www.okx.com';
const CHAIN_SOLANA = '501';

// 用 SOL 作为探测对象（成熟、有共识、必然被支持）
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_1     = String(1e9); // 1 SOL in lamports

const SEP = '─'.repeat(70);

// ─── 认证 ──────────────────────────────────────────────────────────────────

function buildHeaders(method: 'GET' | 'POST', pathWithQuery: string, body = '') {
  const apiKey     = process.env.OKX_API_KEY     ?? '';
  const secretKey  = process.env.OKX_SECRET_KEY  ?? '';
  const passphrase = process.env.OKX_PASSPHRASE  ?? '';
  const projectId  = process.env.OKX_PROJECT_ID  ?? '';
  const timestamp  = new Date().toISOString();
  const message    = `${timestamp}${method}${pathWithQuery}${body}`;
  const sign       = crypto.createHmac('sha256', secretKey).update(message).digest('base64');
  return {
    'OK-ACCESS-KEY':        apiKey,
    'OK-ACCESS-SIGN':       sign,
    'OK-ACCESS-TIMESTAMP':  timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-PROJECT':    projectId,
    'Content-Type':         'application/json',
  };
}

async function get(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const query         = new URLSearchParams(params).toString();
  const pathWithQuery = query ? `${endpoint}?${query}` : endpoint;
  const res = await axios.get(`${BASE_URL}${pathWithQuery}`, {
    headers: buildHeaders('GET', pathWithQuery),
    timeout: 12_000,
  });
  return res.data;
}

// ─── 探测工具 ──────────────────────────────────────────────────────────────

async function probe(label: string, endpoint: string, params: Record<string, string>) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`  路径: ${endpoint}`);
  console.log(`  参数: ${JSON.stringify(params)}`);
  console.log(SEP);
  try {
    const data = await get(endpoint, params);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`  ❌ HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`);
    } else {
      console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(70));
  console.log('  OKX DEX V6 全量端点探测 — 对象: SOL');
  console.log('═'.repeat(70));

  // ── 1. 支持的代币列表 ────────────────────────────────────────────────────
  await probe(
    '1. 支持代币列表 (all-tokens)',
    '/api/v6/dex/aggregator/all-tokens',
    { chainIndex: CHAIN_SOLANA },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 2. Swap 报价：SOL → USDC ────────────────────────────────────────────
  await probe(
    '2. Swap 报价 (quote)  SOL → USDC',
    '/api/v6/dex/aggregator/quote',
    {
      chainIndex:       CHAIN_SOLANA,
      fromTokenAddress: SOL_MINT,
      toTokenAddress:   USDC_MINT,
      amount:           SOL_1,
      slippage:         '0.005',
    },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 3. 代币详情 ──────────────────────────────────────────────────────────
  await probe(
    '3. 代币详情 (token-detail)',
    '/api/v6/dex/aggregator/token-detail',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 4. 当前价格 ──────────────────────────────────────────────────────────
  await probe(
    '4. 代币价格 (token-price / current-price)',
    '/api/v6/dex/aggregator/current-price',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 5. 流动性 ────────────────────────────────────────────────────────────
  await probe(
    '5. 流动性信息 (get-liquidity)',
    '/api/v6/dex/aggregator/get-liquidity',
    {
      chainIndex:       CHAIN_SOLANA,
      fromTokenAddress: SOL_MINT,
      toTokenAddress:   USDC_MINT,
    },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 6. 市场价格 (market 命名空间) ────────────────────────────────────────
  await probe(
    '6. 市场代币价格 (market/token-price)',
    '/api/v6/dex/market/token-price',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 7. K线/OHLCV ─────────────────────────────────────────────────────────
  await probe(
    '7. K线数据 (market/candles)',
    '/api/v6/dex/market/candles',
    {
      chainIndex:    CHAIN_SOLANA,
      tokenAddress:  SOL_MINT,
      bar:           '1H',
      limit:         '5',
    },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 8. 历史成交量 ────────────────────────────────────────────────────────
  await probe(
    '8. 历史成交量 (market/volume)',
    '/api/v6/dex/market/volume',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 9. 代币 Overview ─────────────────────────────────────────────────────
  await probe(
    '9. 代币 Overview (market/token-overview)',
    '/api/v6/dex/market/token-overview',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 10. 24h 行情 ─────────────────────────────────────────────────────────
  await probe(
    '10. 24h 行情 (market/ticker)',
    '/api/v6/dex/market/ticker',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 11. 持有人信息 ───────────────────────────────────────────────────────
  await probe(
    '11. 持有人信息 (market/token-holder)',
    '/api/v6/dex/market/token-holder',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT, limit: '5' },
  );

  await new Promise(r => setTimeout(r, 800));

  // ── 12. 交易历史 ─────────────────────────────────────────────────────────
  await probe(
    '12. 最近交易 (market/transactions)',
    '/api/v6/dex/market/transactions',
    { chainIndex: CHAIN_SOLANA, tokenAddress: SOL_MINT, limit: '5' },
  );

  console.log(`\n${'═'.repeat(70)}\n  探测完成\n${'═'.repeat(70)}\n`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
