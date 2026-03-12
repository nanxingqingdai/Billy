/**
 * Kimi (Moonshot AI) 服务封装
 * API 兼容 OpenAI 格式，通过 axios 直接调用
 *
 * 主要用途：
 * 1. 每次价格扫描时对每个代币生成行情解读（高频，消耗月度额度）
 * 2. 信号触发时提供第二视角分析追加到 TG 消息
 */

import axios from 'axios';
import { config } from '../config/env';
import { log } from '../utils/logger';

const BASE_URL = 'https://api.moonshot.cn/v1/chat/completions';
const MODEL    = 'moonshot-v1-8k';

export function isKimiConfigured(): boolean {
  return Boolean(config.kimiApiKey);
}

async function askKimi(prompt: string, timeoutMs = 12_000): Promise<string> {
  if (!config.kimiApiKey) throw new Error('Kimi not configured (KIMI_API_KEY missing)');

  const resp = await axios.post(
    BASE_URL,
    {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${config.kimiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    },
  );

  return (resp.data.choices?.[0]?.message?.content ?? '').trim();
}

// ─── Feature: 每次扫描的代币行情解读 ───────────────────────────────────────

export interface TokenCommentaryInput {
  symbol:      string;
  price:       number;
  change24h:   number;
  hasPosition: boolean;
  entryPrice?: number;
  pnlPct?:     number;
}

/**
 * 对单个代币生成一句行情解读。
 * 非阻塞设计：调用方应 fire-and-forget（不 await），避免拖慢扫描循环。
 */
export async function getTokenCommentary(input: TokenCommentaryInput): Promise<string> {
  const holdingInfo = input.hasPosition && input.entryPrice !== undefined
    ? `当前持有该代币，开仓价 $${input.entryPrice.toFixed(6)}，当前盈亏 ${input.pnlPct !== undefined ? (input.pnlPct >= 0 ? '+' : '') + input.pnlPct.toFixed(1) + '%' : '未知'}。`
    : '当前未持有该代币。';

  const prompt = `你是一名 Solana Memecoin 行情分析员，用一句话（25字以内）评价以下代币的当前状态，风格简洁直接，不需要标题或符号。
代币: ${input.symbol}
当前价格: $${input.price.toFixed(6)}
24h涨跌: ${input.change24h >= 0 ? '+' : ''}${input.change24h.toFixed(2)}%
${holdingInfo}`;

  try {
    return await askKimi(prompt, 10_000);
  } catch (err) {
    log('WARN', `[Kimi] ${input.symbol} 行情解读失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

// ─── Feature: 信号第二视角分析 ──────────────────────────────────────────────

export interface SignalSecondOpinionInput {
  symbol:          string;
  athMarketCapUsd: number;
  drawdownPct:     number;
  ageDays:         number;
  lowAmpBars:      number;
  lowVolBars:      number;
  priceImpactPct:  number;
  marketCapStr:    string;
  change24hStr:    string;
}

/**
 * 信号触发时，Kimi 提供独立的第二视角评价（2句话内），追加到 TG 消息。
 */
export async function getSignalSecondOpinion(input: SignalSecondOpinionInput): Promise<string> {
  const prompt = `你是独立的 Solana Memecoin 交易分析师，用2句话给出对以下买入信号的独立看法，重点关注风险面。不要重复数据，不要使用 Markdown，用中文回答。

代币: ${input.symbol}
ATH市值: $${(input.athMarketCapUsd / 1_000_000).toFixed(2)}M
距ATH跌幅: ${input.drawdownPct.toFixed(1)}%
代币年龄: ${Math.floor(input.ageDays)} 天
低振幅K线: ${input.lowAmpBars} 根
低成交量K线: ${input.lowVolBars} 根
价格冲击: ${input.priceImpactPct.toFixed(2)}%
当前市值: ${input.marketCapStr}
24h涨跌: ${input.change24hStr}`;

  try {
    return await askKimi(prompt, 12_000);
  } catch (err) {
    log('WARN', `[Kimi] 信号第二视角失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
