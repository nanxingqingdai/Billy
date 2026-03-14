/**
 * 备用市场数据聚合器（Birdeye 全部 key 耗尽时启用）
 *
 * 策略：同时调用优先级最高的两个可用数据源，交叉验证现货价格。
 * 优先级：DexScreener > OKX DEX > GeckoTerminal
 *
 * - 两个源的价格差 > 5%：记录警告，采用更高优先级的数据
 * - 任一源失败：降级到单源，标记 crossValidated=false
 * - OHLCV 数据（K 线历史）：仅 GeckoTerminal 提供，直接调用
 */

import { getDexScreenerSummary } from './dexscreener';
import { getOkxTokenPrice, isOkxConfigured } from './okxDex';
import { log } from '../utils/logger';
import type { TokenPrice, OHLCVCandle, KlineInterval, EntryPreConditions } from './birdeye';

// ─── Types ──────────────────────────────────────────────────────────────────

type SourceName = 'dexscreener' | 'okxdex' | 'geckoterminal';

export interface ValidatedPrice extends TokenPrice {
  source:         SourceName;
  crossValidated: boolean;
  secondSource?:  SourceName;
  priceDiffPct?:  number;
}

// ─── Source priority list ────────────────────────────────────────────────────
// 根据可用性动态选出优先级最高的两个源

function getTopTwoSources(): [SourceName, SourceName] {
  if (isOkxConfigured()) {
    return ['dexscreener', 'okxdex'];
  }
  return ['dexscreener', 'geckoterminal'];
}

// ─── Per-source price fetch ──────────────────────────────────────────────────

async function fetchPriceFrom(source: SourceName, mint: string): Promise<TokenPrice> {
  switch (source) {
    case 'dexscreener': {
      const ds = await getDexScreenerSummary(mint);
      if (ds.priceUsd === 0) throw new Error('DexScreener: price is 0');
      return {
        value:           ds.priceUsd,
        updateUnixTime:  Math.floor(Date.now() / 1000),
        updateHumanTime: new Date().toISOString(),
        priceChange24h:  ds.priceChange24h,
      };
    }
    case 'okxdex': {
      const okx = await getOkxTokenPrice(mint);
      if (okx.priceUsd === 0) throw new Error('OKX DEX: price is 0');
      return {
        value:           okx.priceUsd,
        updateUnixTime:  Math.floor(Date.now() / 1000),
        updateHumanTime: new Date().toISOString(),
        priceChange24h:  0,   // OKX DEX 不提供 24h 涨跌
      };
    }
    case 'geckoterminal': {
      const { getTokenPrice } = await import('./geckoTerminal');
      return getTokenPrice(mint);
    }
  }
}

// ─── Cross-validated price ───────────────────────────────────────────────────

const PRICE_DIFF_WARN_PCT = 5;  // 超过此差异则记录警告

export async function getValidatedPrice(mint: string): Promise<ValidatedPrice> {
  const [src1, src2] = getTopTwoSources();

  const [r1, r2] = await Promise.allSettled([
    fetchPriceFrom(src1, mint),
    fetchPriceFrom(src2, mint),
  ]);

  const p1 = r1.status === 'fulfilled' ? r1.value : null;
  const p2 = r2.status === 'fulfilled' ? r2.value : null;

  if (!p1 && !p2) {
    throw new Error(`[MarketFallback] All sources failed for ${mint.slice(0, 8)}`);
  }

  // 只有一个源成功
  if (!p1) return { ...p2!, source: src2, crossValidated: false };
  if (!p2) return { ...p1,  source: src1, crossValidated: false };

  // 两个源都成功 → 交叉验证
  const diffPct = Math.abs(p1.value - p2.value) / p1.value * 100;

  if (diffPct > PRICE_DIFF_WARN_PCT) {
    log('WARN',
      `[MarketFallback] 价格偏差 ${diffPct.toFixed(1)}%` +
      ` | ${src1}: $${p1.value.toFixed(8)}` +
      ` | ${src2}: $${p2.value.toFixed(8)}` +
      ` — 采用 ${src1}`
    );
  } else {
    log('INFO', `[MarketFallback] 交叉验证通过 (${src1}+${src2}) 差异 ${diffPct.toFixed(2)}%`);
  }

  // 采用优先级更高的源（src1）
  return {
    ...p1,
    source:         src1,
    crossValidated: true,
    secondSource:   src2,
    priceDiffPct:   diffPct,
  };
}

// ─── OHLCV：Birdeye 优先，429 / 失败时切换到 GeckoTerminal ──────────────────

export async function getRecentOHLCV(
  mint: string,
  interval: KlineInterval,
  limit: number,
): Promise<OHLCVCandle[]> {
  // ① 优先 Birdeye（6 个 key 轮转，承受力更强）
  try {
    const { getRecentOHLCV: birdeyeOHLCV } = await import('./birdeye');
    const candles = await birdeyeOHLCV(mint, interval, limit);
    if (candles.length > 0) return candles;
  } catch (err: any) {
    log('WARN', `[MarketFallback] Birdeye OHLCV 失败 (${err.message?.slice(0,60)})，切换 GeckoTerminal`);
  }

  // ② 降级到 GeckoTerminal
  const { getRecentOHLCV: gtOHLCV } = await import('./geckoTerminal');
  return gtOHLCV(mint, interval, limit);
}

// ─── 入场前置条件检查：Birdeye 优先，失败切换 GeckoTerminal ─────────────────

export async function checkEntryPreConditions(mint: string): Promise<EntryPreConditions> {
  // ① 优先 Birdeye
  try {
    const { checkEntryPreConditions: birdeyeCheck } = await import('./birdeye');
    return await birdeyeCheck(mint);
  } catch (err: any) {
    log('WARN', `[MarketFallback] Birdeye checkEntry 失败 (${err.message?.slice(0,60)})，切换 GeckoTerminal`);
  }

  // ② 降级到 GeckoTerminal
  const { checkEntryPreConditions: gtCheck } = await import('./geckoTerminal');
  return gtCheck(mint);
}
