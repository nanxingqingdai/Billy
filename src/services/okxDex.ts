/**
 * OKX DEX WaaS API — Validation & Swap service
 *
 * .env 需要配置：
 *   OKX_PROJECT_ID=...
 *   OKX_API_KEY=...
 *   OKX_SECRET_KEY=...
 *   OKX_PASSPHRASE=...
 *
 * 用途：
 *   1. getOkxTokenPrice()   — 交叉验证 Birdeye 价格
 *   2. getOkxSwapQuote()    — Jupiter 不可用时的备用报价
 *   3. getSupportedTokens() — 连通性测试 / 验证代币是否在 OKX 支持列表
 */

import axios, { AxiosError } from 'axios';
import crypto from 'crypto';

// ─── 常量 ──────────────────────────────────────────────────────────────────

const BASE_URL     = 'https://www.okx.com';
const CHAIN_SOLANA = '501';

// Solana 上的 USDC — 用于价格推导（quote 1 USDC → target token）
const USDC_SOLANA  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_RAW_1   = '1000000'; // 1 USDC = 10^6 raw units

// ─── 凭证 ──────────────────────────────────────────────────────────────────

function getCreds() {
  return {
    apiKey:     process.env.OKX_API_KEY     ?? '',
    secretKey:  process.env.OKX_SECRET_KEY  ?? '',
    passphrase: process.env.OKX_PASSPHRASE  ?? '',
    projectId:  process.env.OKX_PROJECT_ID  ?? '',
  };
}

export function isOkxConfigured(): boolean {
  const { apiKey, secretKey, passphrase, projectId } = getCreds();
  return Boolean(apiKey && secretKey && passphrase && projectId);
}

// ─── 签名 ──────────────────────────────────────────────────────────────────
// OKX 签名规则：Base64(HMAC-SHA256(secretKey, timestamp + METHOD + pathWithQuery + body))
// GET 请求：pathWithQuery 必须包含完整 query string，否则 401

function buildHeaders(method: 'GET' | 'POST', pathWithQuery: string, body = ''): Record<string, string> {
  const { apiKey, secretKey, passphrase, projectId } = getCreds();
  const timestamp = new Date().toISOString();
  const message   = `${timestamp}${method}${pathWithQuery}${body}`;
  const sign      = crypto.createHmac('sha256', secretKey).update(message).digest('base64');

  return {
    'OK-ACCESS-KEY':        apiKey,
    'OK-ACCESS-SIGN':       sign,
    'OK-ACCESS-TIMESTAMP':  timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-PROJECT':    projectId,
    'Content-Type':         'application/json',
  };
}

// ─── 通用 GET 封装 ──────────────────────────────────────────────────────────
// 手动拼 query string，确保签名与实际请求的 URL 完全一致

async function okxGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const query         = new URLSearchParams(params).toString();
  const pathWithQuery = query ? `${endpoint}?${query}` : endpoint;
  const headers       = buildHeaders('GET', pathWithQuery);

  try {
    const res = await axios.get<T>(`${BASE_URL}${pathWithQuery}`, {
      headers,
      timeout: 10_000,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const e = err as AxiosError<{ code?: string; msg?: string }>;
      const code = e.response?.data?.code;
      const msg  = e.response?.data?.msg ?? e.message;
      throw new Error(`OKX API error [${e.response?.status ?? 'network'} code=${code}]: ${msg}`);
    }
    throw err;
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OkxTokenInfo {
  tokenContractAddress: string;
  tokenSymbol:          string;
  tokenName:            string;
  decimals:             string;
  logoUrl?:             string;
}

export interface OkxTokenPrice {
  priceUsd:        number;  // 推导自 USDC→token quote
  inputUsdcAmount: number;  // 实际使用的 USDC 输入量（USD）
  outputTokenRaw:  string;  // 原始 toTokenAmount
  decimals:        number;
}

export interface OkxQuoteParams {
  fromTokenAddress: string;
  toTokenAddress:   string;
  amount:           string;  // raw 最小单位
  slippage?:        string;  // 默认 "0.005" = 0.5%
}

export interface OkxQuoteResult {
  fromTokenAmount:  string;
  toTokenAmount:    string;
  priceImpactPct:   number;
  estimatedGas:     string;
  routerResult:     unknown;
  rawResponse:      unknown; // 保留完整原始响应，便于调试
}

// ─── 1. 获取支持的代币列表（连通性测试） ──────────────────────────────────

interface RawTokenListResp {
  code: string;
  msg:  string;
  data: OkxTokenInfo[];
}

/**
 * 获取 Solana 链上 OKX DEX 支持的代币列表。
 * 主要用于连通性验证 + 检查某代币是否在支持范围内。
 */
export async function getSupportedTokens(chainIndex = CHAIN_SOLANA): Promise<OkxTokenInfo[]> {
  const resp = await okxGet<RawTokenListResp>(
    '/api/v5/dex/aggregator/all-tokens',
    { chainIndex },
  );
  if (resp.code !== '0') throw new Error(`OKX all-tokens: code=${resp.code} msg=${resp.msg}`);
  return resp.data;
}

// ─── 2. 获取代币报价（推导现货价格） ──────────────────────────────────────

interface RawQuoteResp {
  code: string;
  msg:  string;
  data: {
    fromTokenAmount:  string;
    toTokenAmount:    string;
    priceImpactPct?:  string;
    estimatedGas?:    string;
    routerResult?:    unknown;
    [key: string]:    unknown;
  }[];
}

/**
 * 向 OKX DEX 请求 swap 报价。
 * slippage 格式："0.005" = 0.5%，"0.01" = 1%
 */
export async function getOkxSwapQuote(
  params: OkxQuoteParams,
  chainIndex = CHAIN_SOLANA,
): Promise<OkxQuoteResult> {
  const resp = await okxGet<RawQuoteResp>(
    '/api/v5/dex/aggregator/quote',
    {
      chainIndex,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress:   params.toTokenAddress,
      amount:           params.amount,
      slippage:         params.slippage ?? '0.005',
    },
  );

  if (resp.code !== '0') throw new Error(`OKX quote: code=${resp.code} msg=${resp.msg}`);
  const d = resp.data[0];
  if (!d) throw new Error('OKX quote: empty data array');

  return {
    fromTokenAmount:  d.fromTokenAmount,
    toTokenAmount:    d.toTokenAmount,
    priceImpactPct:   parseFloat(d.priceImpactPct ?? '0'),
    estimatedGas:     d.estimatedGas ?? '0',
    routerResult:     d.routerResult ?? null,
    rawResponse:      d,
  };
}

// ─── 3. 推导现货价格（1 USDC → token） ────────────────────────────────────

/**
 * 通过"1 USDC → target token"的报价推导代币的 USD 现货价格。
 *
 * price = 1 USDC / output_tokens_ui
 *       = 1_000_000_raw_usdc / toTokenAmount * 10^(tokenDecimals - 6)
 *
 * @param tokenAddress  目标代币 mint
 * @param tokenDecimals 代币精度（默认 6，Solana memecoin 通常如此）
 */
export async function getOkxTokenPrice(
  tokenAddress: string,
  tokenDecimals = 6,
  chainIndex    = CHAIN_SOLANA,
): Promise<OkxTokenPrice> {
  const quote = await getOkxSwapQuote(
    {
      fromTokenAddress: USDC_SOLANA,
      toTokenAddress:   tokenAddress,
      amount:           USDC_RAW_1,
    },
    chainIndex,
  );

  const outputTokenRaw = quote.toTokenAmount;
  const outputTokenUi  = parseFloat(outputTokenRaw) / Math.pow(10, tokenDecimals);
  const priceUsd       = outputTokenUi > 0 ? 1 / outputTokenUi : 0;

  return {
    priceUsd,
    inputUsdcAmount: 1,
    outputTokenRaw,
    decimals: tokenDecimals,
  };
}
