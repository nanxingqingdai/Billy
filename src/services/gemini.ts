/**
 * Gemini AI 服务封装
 * 提供信号分析、代币筛查、日报生成、问答四项功能
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config/env';
import { log } from '../utils/logger';

// ─── Client ─────────────────────────────────────────────────────────────────

let _client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (!config.googleAiApiKey) return null;
  if (!_client) _client = new GoogleGenerativeAI(config.googleAiApiKey);
  return _client;
}

export function isGeminiConfigured(): boolean {
  return Boolean(config.googleAiApiKey);
}

async function askGemini(prompt: string, timeoutMs = 15_000): Promise<string> {
  const client = getClient();
  if (!client) throw new Error('Gemini not configured (GOOGLE_AI_API_KEY missing)');

  const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), timeoutMs),
    ),
  ]) as Awaited<ReturnType<typeof model.generateContent>>;

  return result.response.text().trim();
}

// ─── Feature 1: Signal Analysis ─────────────────────────────────────────────

export interface SignalAnalysisInput {
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

export async function generateSignalAnalysis(input: SignalAnalysisInput): Promise<string> {
  const prompt = `你是一名 Solana Memecoin 量化交易分析师。
以下是一个买入信号的技术参数，请用2-3句话简短评价信号质量，指出最值得关注的优缺点，给出倾向性建议（买入/观望/谨慎）。不要重复已有数据，直接给出判断，用中文回答，不要使用 Markdown。

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
    return await askGemini(prompt, 12_000);
  } catch (err) {
    log('WARN', `[Gemini] 信号分析失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

// ─── Feature 3: Token Screening ─────────────────────────────────────────────

export interface TokenScreenInput {
  symbol:          string;
  mint:            string;
  athMarketCapUsd: number;
  drawdownPct:     number;
  ageDays:         number;
  path:            string;
}

export interface TokenScreenResult {
  pass:   boolean;
  reason: string;
}

export async function screenToken(input: TokenScreenInput): Promise<TokenScreenResult> {
  const prompt = `你是一名 Solana Memecoin 风险筛查员。
判断以下代币是否应该进入下一步买入评估，主要过滤死亡项目、明显骗局、异常参数。
请只回答以下格式（不要任何其他内容）：
PASS: <一句话理由>
或
FAIL: <一句话理由>

代币符号: ${input.symbol}
合约地址: ${input.mint}
ATH市值: $${(input.athMarketCapUsd / 1_000_000).toFixed(2)}M
距ATH跌幅: ${input.drawdownPct.toFixed(1)}%
代币年龄: ${Math.floor(input.ageDays)} 天
类型: ${input.path}`;

  try {
    const text = await askGemini(prompt, 12_000);
    if (/^PASS/i.test(text)) {
      return { pass: true, reason: text.replace(/^PASS:\s*/i, '').trim() };
    }
    return { pass: false, reason: text.replace(/^FAIL:\s*/i, '').trim() };
  } catch (err) {
    log('WARN', `[Gemini] 代币筛查失败: ${err instanceof Error ? err.message : String(err)}`);
    // Fail-open: don't block the trade if Gemini is unavailable
    return { pass: true, reason: 'Gemini 不可用，跳过筛查' };
  }
}

// ─── Feature 2: Daily Summary ────────────────────────────────────────────────

export interface DailySummaryInput {
  date:           string;
  signalCount:    number;
  tradeCount:     number;
  totalPnlUsdt:   number;
  winCount:       number;
  lossCount:      number;
  openPositions:  number;
  topSignals:     string[];
  watchlistCount: number;
}

export async function generateDailySummary(input: DailySummaryInput): Promise<string> {
  const pnlSign = input.totalPnlUsdt >= 0 ? '+' : '';
  const prompt = `你是量化交易系统的日报生成助手。
根据以下今日交易数据，生成简洁的中文日报（3-5句话），总结盈亏情况、信号质量和值得关注的要点。不要使用 Markdown，不要添加标题，用自然语言表述。

日期: ${input.date}
信号触发: ${input.signalCount} 次
实际交易: ${input.tradeCount} 次
总盈亏: ${pnlSign}$${input.totalPnlUsdt.toFixed(2)} USDT
盈利笔数: ${input.winCount}
亏损笔数: ${input.lossCount}
当前持仓: ${input.openPositions} 个
监控代币: ${input.watchlistCount} 个
今日信号代币: ${input.topSignals.join(', ') || '无'}`;

  try {
    return await askGemini(prompt, 15_000);
  } catch (err) {
    log('WARN', `[Gemini] 日报生成失败: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

// ─── Feature 4: Dashboard Q&A ────────────────────────────────────────────────

export async function answerQuery(question: string, context: string): Promise<string> {
  const prompt = `你是 BillyCode 量化交易机器人的智能助手。
根据以下机器人实时状态数据，回答用户的问题。回答请简洁，用中文，不要使用 Markdown。

=== 机器人状态 ===
${context}

=== 用户问题 ===
${question}`;

  try {
    return await askGemini(prompt, 20_000);
  } catch (err) {
    log('WARN', `[Gemini] 问答失败: ${err instanceof Error ? err.message : String(err)}`);
    return '抱歉，AI 助手暂时不可用，请稍后再试。';
  }
}
