/**
 * Telegram 买入信号通知服务
 *
 * .env 需配置：
 *   TG_BOT_TOKEN=<BotFather 给的 token>
 *   TG_CHAT_ID=<你的个人 chat id，发消息给 @userinfobot 可查>
 */

import axios from 'axios';
import { log } from '../utils/logger';
import { getDexScreenerSummary } from './dexscreener';
import type { TokenPath } from './birdeye';

const BOT_TOKEN = process.env.TG_BOT_TOKEN ?? '';
const CHAT_ID   = process.env.TG_CHAT_ID   ?? '';

export function isTelegramConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

async function sendMessage(text: string): Promise<void> {
  if (!isTelegramConfigured()) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:    CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10_000 },
    );
  } catch (err) {
    log('WARN', `[TG] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── 格式化工具 ─────────────────────────────────────────────────────────────

/** 将 USD 金额格式化为 $1.23M / $456.78K */
function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${(value / 1_000).toFixed(2)}K`;
}

// ─── 路径相关标签 & 阈值 ────────────────────────────────────────────────────

interface PathLabels {
  ampLabel: string;
  volLabel: string;
}

interface PathThresholds {
  drawdownMin: number;
  ampMin:      number;
  volMin:      number;
}

function getPathLabels(path: TokenPath, athMarketCapUsd: number, volThresholdUsd: number): PathLabels {
  const volFmt = formatUsd(volThresholdUsd);
  switch (path) {
    case 'mature':
      return {
        ampLabel: `低振幅K线（日波动≤15%）`,
        volLabel: `低成交量K线（${athMarketCapUsd >= 100_000_000 ? 'ATH≥$100M，' : ''}日成交量&lt;${volFmt}）`,
      };
    case 'young-large':
      return {
        ampLabel: `低振幅K线（4H波动&lt;20%）`,
        volLabel: `低成交量K线（ATH&gt;$20M，4H成交量&lt;${volFmt}）`,
      };
    case 'young-small':
      return {
        ampLabel: `低振幅K线（4H波动&lt;10%）`,
        volLabel: `低成交量K线（4H成交量&lt;${volFmt}）`,
      };
  }
}

function getPathThresholds(path: TokenPath): PathThresholds {
  switch (path) {
    case 'mature':      return { drawdownMin: 80, ampMin: 3, volMin: 3 };
    case 'young-large': return { drawdownMin: 90, ampMin: 4, volMin: 4 };
    case 'young-small': return { drawdownMin: 90, ampMin: 4, volMin: 4 };
  }
}

// ─── 买入信号通知 ───────────────────────────────────────────────────────────

export interface BuySignalParams {
  symbol:             string;
  mint:               string;
  athMarketCapUsd:    number;
  drawdownPct:        number;
  lowAmpBars:         number;
  lowVolBars:         number;
  volThresholdUsd:    number;
  path:               TokenPath;
  priceImpactPct:     number;
  buyAmountUsdt:      number;
  maxPriceImpactPct?: number;   // default 3%
}

export async function notifyBuySignal(p: BuySignalParams): Promise<void> {
  // ── 从 DexScreener 取实时市值、24h涨跌、精确代币年龄 ────────────────────
  let marketCapStr    = 'N/A';
  let change24hStr    = 'N/A';
  let change24hIcon   = '';
  let ageDaysStr      = '?';

  try {
    const ds = await getDexScreenerSummary(p.mint);

    // 市值
    marketCapStr = formatUsd(ds.marketCap);

    // 24h 涨跌
    const pct = ds.priceChange24h ?? 0;
    change24hIcon = pct >= 0 ? '📈' : '📉';
    change24hStr  = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

    // 精确年龄：用 DexScreener 的 pairCreatedAt（最早交易对创建时间）
    if (ds.earliestPairCreatedMs > 0) {
      const ageMs = Date.now() - ds.earliestPairCreatedMs;
      ageDaysStr  = Math.floor(ageMs / 86_400_000).toString();
    }
  } catch (err) {
    log('WARN', `[TG] DexScreener 数据获取失败，通知仍将发送: ${err instanceof Error ? err.message : String(err)}`);
  }

  const labels     = getPathLabels(p.path, p.athMarketCapUsd, p.volThresholdUsd);
  const thresholds = getPathThresholds(p.path);
  const maxImpact  = p.maxPriceImpactPct ?? 3;

  const ck = (ok: boolean) => ok ? '✅' : '❌';
  const drawdownOk = p.drawdownPct    >= thresholds.drawdownMin;
  const ampOk      = p.lowAmpBars    >= thresholds.ampMin;
  const volOk      = p.lowVolBars    >= thresholds.volMin;
  const impactOk   = p.priceImpactPct <= maxImpact;

  const passCount  = [drawdownOk, ampOk, volOk, impactOk].filter(Boolean).length;
  const allPassed  = passCount === 4;
  const conclusion = allPassed
    ? `🎯 <b>结论: ✅ 全部通过 — 建议买入 $${p.buyAmountUsdt} USDT</b>`
    : `🎯 <b>结论: ❌ 未全部通过（${passCount}/4）— 仅供参考</b>`;

  const dexUrl  = `https://dexscreener.com/solana/${p.mint}`;
  const birdUrl = `https://birdeye.so/token/${p.mint}?chain=solana`;

  const text = [
    `🚨 <b>买入信号 — ${p.symbol}</b>`,
    ``,
    `💰 市值: <b>${marketCapStr}</b>  ${change24hIcon} ${change24hStr}`,
    ``,
    `📋 <b>核查清单</b>`,
    `  ${ck(drawdownOk)} 距ATH ${formatUsd(p.athMarketCapUsd)} 跌幅: ${p.drawdownPct.toFixed(2)}%（需≥${thresholds.drawdownMin}%）`,
    `  ${ck(ampOk)} ${labels.ampLabel}: ${p.lowAmpBars} 根（需≥${thresholds.ampMin}根）`,
    `  ${ck(volOk)} ${labels.volLabel}: ${p.lowVolBars} 根（需≥${thresholds.volMin}根）`,
    `  ${ck(impactOk)} 价格冲击: ${p.priceImpactPct.toFixed(2)}%（需≤${maxImpact}%）`,
    `  📅 代币年龄: ${ageDaysStr} 天`,
    ``,
    conclusion,
    ``,
    `🔗 <a href="${dexUrl}">DexScreener</a>  |  <a href="${birdUrl}">Birdeye</a>`,
    ``,
    `📋 CA: <code>${p.mint}</code>`,
  ].join('\n');

  await sendMessage(text);
  log('INFO', `[TG] 买入信号通知已发送: ${p.symbol}`);
}

// ─── Moonshot 新代币入库通知 ────────────────────────────────────────────────

export async function notifyNewToken(symbol: string, mint: string, drawdownPct: number, ageDays: number): Promise<void> {
  const text = [
    `✅ <b>新代币加入监控 — ${symbol}</b>`,
    `跌幅: ${drawdownPct.toFixed(1)}% | 年龄: ${Math.floor(ageDays)}天`,
    `<code>${mint}</code>`,
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
  ].join('\n');

  await sendMessage(text);
}

// ─── 系统状态通知 ───────────────────────────────────────────────────────────

export async function notifyStartup(tokenCount: number): Promise<void> {
  await sendMessage(
    `🤖 <b>BillyCode 监控已启动</b>\n监控代币: ${tokenCount} 个\n模式: 信号通知（手动交易）`
  );
}
