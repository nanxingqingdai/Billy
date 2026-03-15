/**
 * GeckoTerminal OHLCV 服务
 *
 * 作为 Birdeye 额度耗尽时的备用 K 线数据源。
 * 暴露与 birdeye.ts 相同命名的函数，birdeye.ts 可透明切换到此服务。
 *
 * 成交量处理：聚合多个交易池的成交量（最多 MAX_POOLS 个），避免单池数据严重低估。
 * 价格数据：来自流动性最高的池（价格在各池基本一致）。
 */

import axios from 'axios';
import { log } from '../utils/logger';
import { getDexScreenerSummary } from './dexscreener';
import type {
  OHLCVCandle,
  KlineInterval,
  TokenPrice,
  TokenOverview,
  EntryPreConditions,
  TokenPath,
} from './birdeye';

const BASE_URL      = 'https://api.geckoterminal.com/api/v2';
const GT_HDR        = { Accept: 'application/json' };
const MAX_POOLS     = 1;      // 只用流动性最高的池（最小化 API 调用，价格在各池基本一致）
const GT_BATCH_SIZE = 1000;   // GeckoTerminal 单次最多返回 1000 根 K 线

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 全局限速器（免费 30 次/分钟，留余量控制在 25 次/分钟 ≈ 2.4秒/次）─────
const GT_MIN_INTERVAL_MS = 2500; // 每次请求至少间隔 2.5 秒
let _lastGtRequestTime = 0;

async function gtThrottle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastGtRequestTime;
  if (elapsed < GT_MIN_INTERVAL_MS) {
    await sleep(GT_MIN_INTERVAL_MS - elapsed);
  }
  _lastGtRequestTime = Date.now();
}

// GeckoTerminal 原始 K 线: [unix_sec, open, high, low, close, volume_target_tokens]
type GTCandle = [number, number, number, number, number, number];

// 池信息：地址 + 目标 token 在该池中的位置（base / quote）
interface PoolInfo {
  address:       string;
  tokenPosition: 'base' | 'quote';
}

// ─── Pool list cache (session-scoped) ───────────────────────────────────────
const poolListCache = new Map<string, PoolInfo[]>();

/**
 * 获取目标 token 流动性最高的 MAX_POOLS 个池。
 * 同时识别该 token 在每个池中是 base 还是 quote，
 * 以便后续 OHLCV 请求使用正确的 token= 参数。
 */
async function getTopPools(mint: string): Promise<PoolInfo[]> {
  if (poolListCache.has(mint)) return poolListCache.get(mint)!;

  let raw: any[] = [];
  for (let attempt = 0; attempt <= 2; attempt++) {
    await gtThrottle();
    try {
      const res = await axios.get(
        `${BASE_URL}/networks/solana/tokens/${mint}/pools`,
        { params: { page: 1, sort: 'h24_volume_usd_desc' }, timeout: 10_000, headers: GT_HDR },
      );
      raw = res.data.data ?? [];
      break;
    } catch (err: any) {
      if (err?.response?.status === 429 && attempt < 2) {
        log('WARN', `[GT] getTopPools 429，等待 ${(attempt + 1) * 5}s 后重试`);
        await sleep((attempt + 1) * 5000);
        continue;
      }
      throw err;
    }
  }
  if (raw.length === 0) throw new Error(`GeckoTerminal: no pools for ${mint}`);

  // 按流动性排序，取前 MAX_POOLS 个
  const sorted = [...raw]
    .sort((a, b) =>
      parseFloat(b.attributes?.reserve_in_usd ?? '0') -
      parseFloat(a.attributes?.reserve_in_usd ?? '0')
    )
    .slice(0, MAX_POOLS);

  const pools: PoolInfo[] = sorted.map(p => {
    // GeckoTerminal pool relationship: relationships.base_token.data.id = "solana_{address}"
    const baseId: string = p.relationships?.base_token?.data?.id ?? '';
    const isBase = baseId.endsWith(mint);
    return {
      address:       p.attributes.address as string,
      tokenPosition: isBase ? 'base' : 'quote',
    };
  });

  poolListCache.set(mint, pools);
  return pools;
}

function toGeckoTimeframe(interval: KlineInterval): { tf: 'day' | 'hour' | 'minute'; agg: number } {
  const map: Record<KlineInterval, { tf: 'day' | 'hour' | 'minute'; agg: number }> = {
    '1m':  { tf: 'minute', agg: 1  },
    '3m':  { tf: 'minute', agg: 3  },
    '5m':  { tf: 'minute', agg: 5  },
    '15m': { tf: 'minute', agg: 15 },
    '30m': { tf: 'minute', agg: 30 },
    '1H':  { tf: 'hour',   agg: 1  },
    '2H':  { tf: 'hour',   agg: 2  },
    '4H':  { tf: 'hour',   agg: 4  },
    '6H':  { tf: 'hour',   agg: 6  },
    '8H':  { tf: 'hour',   agg: 8  },
    '12H': { tf: 'hour',   agg: 12 },
    '1D':  { tf: 'day',    agg: 1  },
    '3D':  { tf: 'day',    agg: 3  },
    '1W':  { tf: 'day',    agg: 7  },
    '1M':  { tf: 'day',    agg: 30 },
  };
  return map[interval];
}

/** 获取单个池的 OHLCV（oldest-first，volume 转换为 USD）
 *  beforeTimestamp：仅返回时间戳 < 该值的 K 线（用于向前分页）
 */
async function fetchPoolOHLCV(
  pool: PoolInfo,
  tf: 'day' | 'hour' | 'minute',
  agg: number,
  limit: number,
  beforeTimestamp?: number,
): Promise<OHLCVCandle[]> {
  const params: Record<string, unknown> = {
    aggregate: agg, limit, currency: 'usd', token: pool.tokenPosition,
  };
  if (beforeTimestamp !== undefined) params.before_timestamp = beforeTimestamp;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await gtThrottle();
    try {
      const res = await axios.get(
        `${BASE_URL}/networks/solana/pools/${pool.address}/ohlcv/${tf}`,
        { params, timeout: 15_000, headers: GT_HDR },
      );
      const raw: GTCandle[] = res.data.data?.attributes?.ohlcv_list ?? [];
      return [...raw].reverse().map(([ts, o, h, l, c, v]) => ({
        unixTime: ts, o, h, l, c,
        v: v * c,
      }));
    } catch (err: any) {
      if (err?.response?.status === 429 && attempt < MAX_RETRIES) {
        const backoff = (attempt + 1) * 5000; // 5s, 10s
        log('WARN', `[GT] 429 限流，等待 ${backoff / 1000}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error('fetchPoolOHLCV: max retries exceeded');
}

/** 单池全量分页（向前翻页直到数据耗尽或到达 timeFloor）*/
async function getAllPoolOHLCV(
  pool: PoolInfo,
  tf: 'day' | 'hour' | 'minute',
  agg: number,
  timeFloor: number,
): Promise<OHLCVCandle[]> {
  const allCandles: OHLCVCandle[] = [];
  let beforeTimestamp: number | undefined;

  while (true) {
    const page = await fetchPoolOHLCV(pool, tf, agg, GT_BATCH_SIZE, beforeTimestamp);
    if (page.length > 0) allCandles.unshift(...page);

    const noMoreData   = page.length < GT_BATCH_SIZE;
    const reachedFloor = page.length > 0 && page[0]!.unixTime <= timeFloor;
    if (noMoreData || reachedFloor) break;

    // 下一页：取比当前最早 K 线更早的数据
    beforeTimestamp = page[0]!.unixTime;
    await sleep(1200);
  }

  // 去重 + 裁剪 floor 以前的数据
  const seen = new Set<number>();
  return allCandles
    .filter(c => c.unixTime >= timeFloor)
    .filter(c => { if (seen.has(c.unixTime)) return false; seen.add(c.unixTime); return true; });
}

// ─── Public: OHLCV（多池聚合）───────────────────────────────────────────────

/**
 * 与 birdeye.getRecentOHLCV 同名，返回 OHLCVCandle[]。
 *
 * 价格（o/h/l/c）：来自流动性最高的池（第一个池）。
 * 成交量（v）：所有池的 USD 成交量按时间戳求和，聚合更接近真实总量。
 */
export async function getRecentOHLCV(
  mint: string,
  interval: KlineInterval,
  limit: number,
): Promise<OHLCVCandle[]> {
  const pools        = await getTopPools(mint);
  const { tf, agg }  = toGeckoTimeframe(interval);

  // 串行拉取各池K线（限速，避免 429）
  const successful: OHLCVCandle[][] = [];
  for (const p of pools) {
    try {
      const candles = await fetchPoolOHLCV(p, tf, agg, limit);
      successful.push(candles);
    } catch { /* 单池失败继续下一个 */ }
  }

  if (successful.length === 0) throw new Error('GeckoTerminal: all pool OHLCV requests failed');

  // 价格来自第一个池（流动性最高，价格最具代表性）
  const priceCandles = successful[0]!;

  if (successful.length === 1) return priceCandles;

  // 按时间戳聚合成交量：各池累加
  const volByTs = new Map<number, number>();
  for (const candles of successful) {
    for (const c of candles) {
      volByTs.set(c.unixTime, (volByTs.get(c.unixTime) ?? 0) + c.v);
    }
  }

  log('INFO', `[GT] OHLCV 聚合: ${successful.length}/${pools.length} 个池 | interval=${interval} | limit=${limit}`);

  return priceCandles.map(c => ({
    ...c,
    v: volByTs.get(c.unixTime) ?? c.v,
  }));
}

/**
 * 与 birdeye.getAllOHLCV 对应：分页获取全量历史 K 线（多池聚合）。
 * floor 默认 5 年前，停止条件与 birdeye 版本一致。
 */
export async function getAllOHLCV(
  mint: string,
  interval: KlineInterval,
  timeFloor?: number,
): Promise<OHLCVCandle[]> {
  const pools  = await getTopPools(mint);
  const { tf, agg } = toGeckoTimeframe(interval);
  const floor  = timeFloor ?? Math.floor(Date.now() / 1000) - 5 * 365 * 86400;

  // 各池独立分页（并发，但各池内部串行翻页 + sleep）
  const results = await Promise.allSettled(
    pools.map(p => getAllPoolOHLCV(p, tf, agg, floor)),
  );
  const successful = results
    .filter((r): r is PromiseFulfilledResult<OHLCVCandle[]> => r.status === 'fulfilled')
    .map(r => r.value);
  if (successful.length === 0) throw new Error('GeckoTerminal: all pool OHLCV pagination failed');

  const priceCandles = successful[0]!;
  if (successful.length === 1) return priceCandles;

  const volByTs = new Map<number, number>();
  for (const candles of successful) {
    for (const c of candles) volByTs.set(c.unixTime, (volByTs.get(c.unixTime) ?? 0) + c.v);
  }
  return priceCandles.map(c => ({ ...c, v: volByTs.get(c.unixTime) ?? c.v }));
}

/**
 * 智能全量日 K 获取：先探针一次请求，若触及 GT_BATCH_SIZE 则分页拉取完整历史。
 */
async function getFullDailyOHLCV(mint: string): Promise<OHLCVCandle[]> {
  const probe = await getRecentOHLCV(mint, '1D', GT_BATCH_SIZE);
  if (probe.length < GT_BATCH_SIZE) return probe;
  log('INFO', `[GT] ${mint.slice(0, 8)}… 日K达到 ${GT_BATCH_SIZE} 根上限，开始分页获取全量历史`);
  const floor5yr = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
  return getAllOHLCV(mint, '1D', floor5yr);
}

// ─── Public: Token market data ──────────────────────────────────────────────

export async function getTokenPrice(mint: string): Promise<TokenPrice> {
  const pools = await getTopPools(mint);
  const pool  = pools[0]!;
  await gtThrottle();
  const res   = await axios.get(
    `${BASE_URL}/networks/solana/pools/${pool.address}`,
    { timeout: 10_000, headers: GT_HDR },
  );
  const a = res.data.data?.attributes;
  const price = pool.tokenPosition === 'base'
    ? parseFloat(a?.base_token_price_usd  ?? '0')
    : parseFloat(a?.quote_token_price_usd ?? '0');
  return {
    value:           price,
    updateUnixTime:  Math.floor(Date.now() / 1000),
    updateHumanTime: new Date().toISOString(),
    priceChange24h:  parseFloat(a?.price_change_percentage?.h24 ?? '0'),
  };
}

export async function getTokenOverview(mint: string): Promise<TokenOverview> {
  const pools = await getTopPools(mint);
  const pool  = pools[0]!;

  await gtThrottle();
  const poolRes = await axios.get(`${BASE_URL}/networks/solana/pools/${pool.address}`,  { timeout: 10_000, headers: GT_HDR });
  await gtThrottle();
  const tokenRes = await axios.get(`${BASE_URL}/networks/solana/tokens/${mint}`, { timeout: 10_000, headers: GT_HDR });

  const pa = poolRes.data.data?.attributes;
  const ta = tokenRes.data.data?.attributes;
  const price = pool.tokenPosition === 'base'
    ? parseFloat(pa?.base_token_price_usd  ?? '0')
    : parseFloat(pa?.quote_token_price_usd ?? '0');
  const mc = parseFloat(ta?.market_cap_usd ?? '0') || parseFloat(ta?.fdv_usd ?? '0');

  return {
    address:               mint,
    symbol:                ta?.symbol   ?? '',
    name:                  ta?.name     ?? '',
    decimals:              ta?.decimals ?? 6,
    price,
    priceChange24hPercent: parseFloat(pa?.price_change_percentage?.h24 ?? '0'),
    v24hUSD:               parseFloat(pa?.volume_usd?.h24 ?? '0'),
    marketCap:             mc,
    liquidity:             parseFloat(pa?.reserve_in_usd ?? '0'),
    trade24h:              0,
    holder:                0,
  };
}

// ─── Public: Pre-condition check (mirrors birdeye.checkEntryPreConditions) ──

export async function checkEntryPreConditions(mint: string): Promise<EntryPreConditions> {
  const AGE_THRESHOLD_DAYS   = 40;
  const MATURE_WINDOW        = 10;
  const MATURE_AMP_MIN       = 3;
  const MATURE_AMP_MAX_PCT   = 15;
  const MATURE_VOL_MIN       = 3;
  const MATURE_VOL_LOW_USD   = 10_000;
  const MATURE_VOL_HIGH_USD  = 20_000;
  const MATURE_ATH_BREAKPOINT = 100_000_000;
  const YOUNG_DRAWDOWN_PCT   = 90;
  const MATURE_DRAWDOWN_PCT  = 80;
  const YOUNG_WINDOW         = 10;
  const YOUNG_ATH_BREAKPOINT = 20_000_000;
  const YOUNG_SMALL_AMP_MIN  = 4;
  const YOUNG_SMALL_AMP_MAX  = 10;
  const YOUNG_SMALL_VOL_MIN  = 4;
  const YOUNG_SMALL_VOL_USD  = 10_000;
  const YOUNG_LARGE_AMP_MIN  = 4;
  const YOUNG_LARGE_AMP_MAX  = 20;
  const YOUNG_LARGE_VOL_MIN  = 4;
  const YOUNG_LARGE_VOL_USD  = 50_000;

  // 当前市值：DexScreener 优先（比 GeckoTerminal 更精准）
  const ds = await getDexScreenerSummary(mint);
  const currentMarketCapUsd = ds.marketCap;
  const currentPrice        = ds.priceUsd;

  // 历史日 K 线（聚合多池，智能全量获取）
  const dailyCandles = await getFullDailyOHLCV(mint);

  const estimatedSupply = currentPrice > 0 ? currentMarketCapUsd / currentPrice : 0;
  const athPrice        = dailyCandles.reduce((max, c) => Math.max(max, c.h), 0);
  const athMarketCapUsd = athPrice * estimatedSupply;
  const drawdownPct     = athMarketCapUsd > 0
    ? ((athMarketCapUsd - currentMarketCapUsd) / athMarketCapUsd) * 100 : 0;

  const firstCandleTime = dailyCandles.length > 0 ? dailyCandles[0]!.unixTime : Date.now() / 1000;
  const ageDays   = (Date.now() / 1000 - firstCandleTime) / 86400;
  const isYoung   = ageDays <= AGE_THRESHOLD_DAYS;
  const reqDrawdown = isYoung ? YOUNG_DRAWDOWN_PCT : MATURE_DRAWDOWN_PCT;

  log('INFO',
    `[GT] ${mint.slice(0, 8)}… | ATH MC: $${athMarketCapUsd.toLocaleString()} | ` +
    `drawdown: ${drawdownPct.toFixed(1)}% | age: ${ageDays.toFixed(0)}d`
  );

  if (drawdownPct < reqDrawdown) {
    return {
      passed: false,
      reason: `ATH drawdown ${drawdownPct.toFixed(1)}% < required ${reqDrawdown}%`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct,
      ageDays, lowAmpBars: 0, lowVolBars: 0, volThresholdUsd: 0,
      path: isYoung ? 'young-small' : 'mature',
    };
  }

  // ── Young token: 4H ──────────────────────────────────────────────────────
  if (isYoung) {
    const candles4h  = await getRecentOHLCV(mint, '4H', YOUNG_WINDOW + 2);
    const window4h   = candles4h.slice(-(YOUNG_WINDOW + 1), -1);

    const isLarge        = athMarketCapUsd > YOUNG_ATH_BREAKPOINT;
    const ampMinCount    = isLarge ? YOUNG_LARGE_AMP_MIN : YOUNG_SMALL_AMP_MIN;
    const ampMaxPct      = isLarge ? YOUNG_LARGE_AMP_MAX : YOUNG_SMALL_AMP_MAX;
    const volMinCount    = isLarge ? YOUNG_LARGE_VOL_MIN : YOUNG_SMALL_VOL_MIN;
    const volThresholdUsd = isLarge ? YOUNG_LARGE_VOL_USD : YOUNG_SMALL_VOL_USD;
    const path: TokenPath = isLarge ? 'young-large' : 'young-small';

    const lowAmpBars = window4h.filter(c => ((c.h - c.l) / c.o) * 100 < ampMaxPct).length;
    const lowVolBars = window4h.filter(c => c.v < volThresholdUsd).length;

    if (lowAmpBars < ampMinCount)
      return { passed: false, reason: `[Young] Low-amp 4H bars ${lowAmpBars}/${ampMinCount}`,
        athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path };

    if (lowVolBars < volMinCount)
      return { passed: false, reason: `[Young] Low-vol 4H bars ${lowVolBars}/${volMinCount}`,
        athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path };

    return { passed: true, reason: 'OK',
      athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path };
  }

  // ── Mature token: 1D ─────────────────────────────────────────────────────
  const window1d        = dailyCandles.slice(-(MATURE_WINDOW + 1), -1);
  const volThresholdUsd = athMarketCapUsd >= MATURE_ATH_BREAKPOINT ? MATURE_VOL_HIGH_USD : MATURE_VOL_LOW_USD;
  const lowAmpBars      = window1d.filter(c => ((c.h - c.l) / c.o) * 100 <= MATURE_AMP_MAX_PCT).length;
  const lowVolBars      = window1d.filter(c => c.v < volThresholdUsd).length;

  if (lowAmpBars < MATURE_AMP_MIN)
    return { passed: false, reason: `Low-amp days ${lowAmpBars}/${MATURE_AMP_MIN}`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature' };

  if (lowVolBars < MATURE_VOL_MIN)
    return { passed: false, reason: `Low-vol days ${lowVolBars}/${MATURE_VOL_MIN}`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature' };

  return { passed: true, reason: 'OK',
    athMarketCapUsd, currentMarketCapUsd, drawdownPct, ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature' };
}
