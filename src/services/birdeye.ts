import axios, { AxiosError } from 'axios';
import { config } from '../config/env';
import { log } from '../utils/logger';

const BASE_URL = 'https://public-api.birdeye.so';

// ─── API key rotation ──────────────────────────────────────────────────────

/** Birdeye 全部 key 都耗尽额度时抛出此错误，触发备用数据栈 */
export class BirdeyeExhaustedError extends Error {
  constructor() { super('All Birdeye API keys exhausted'); this.name = 'BirdeyeExhaustedError'; }
}

let _keyIndex   = 0;
const _exhausted = new Set<number>();

function currentKey(): string {
  return config.birdeyeApiKeys[_keyIndex] ?? config.birdeyeApiKey;
}

/** 尝试切换到下一个未耗尽的 key。返回 true 表示成功，false 表示全部耗尽。 */
function rotateKey(): boolean {
  const total = config.birdeyeApiKeys.length;
  if (total === 0) return false;

  _exhausted.add(_keyIndex);
  for (let i = 1; i < total; i++) {
    const next = (_keyIndex + i) % total;
    if (!_exhausted.has(next)) {
      _keyIndex = next;
      log('WARN', `[Birdeye] Key #${_keyIndex} 额度耗尽，切换到 key #${next}`);
      return true;
    }
  }
  return false;  // 全部耗尽
}

export function isAllBirdeyeKeysExhausted(): boolean {
  return config.birdeyeApiKeys.length > 0 &&
    _exhausted.size >= config.birdeyeApiKeys.length;
}

// ─── Shared HTTP client ────────────────────────────────────────────────────

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 10_000,
  headers: { 'x-chain': 'solana' },
});

// 每次请求动态注入当前 key（支持轮转）
client.interceptors.request.use((reqCfg) => {
  reqCfg.headers['X-API-KEY'] = currentKey();
  return reqCfg;
});

// Auto-retry on 429 / ECONNRESET；Compute-units 耗尽时轮转 key
client.interceptors.response.use(
  (res) => res,
  async (err: unknown) => {
    if (!axios.isAxiosError(err) || !err.config) throw err;

    const cfg = err.config as typeof err.config & { _retryCount?: number; _keyRotated?: boolean };
    const retryCount = cfg._retryCount ?? 0;
    const status     = err.response?.status;
    const code       = err.code;
    const msg: string = (err.response?.data as any)?.message ?? '';

    // ── Compute units exhausted → rotate key & retry once ──────────────
    if (status === 400 && msg.includes('Compute units usage limit exceeded') && !cfg._keyRotated) {
      if (rotateKey()) {
        cfg._keyRotated = true;
        cfg._retryCount = 0;
        return client.request(cfg);
      }
      throw new BirdeyeExhaustedError();
    }

    if (retryCount >= 3) throw err;

    if (status === 429) {
      const retryAfter = Number(err.response?.headers['retry-after'] ?? 1);
      await sleep(retryAfter * 1000 + 500);
      cfg._retryCount = retryCount + 1;
      return client.request(cfg);
    }

    if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      await sleep(1500 * (retryCount + 1));
      cfg._retryCount = retryCount + 1;
      return client.request(cfg);
    }

    throw err;
  }
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type KlineInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | '3D' | '1W' | '1M';

export interface TokenPrice {
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
  priceChange24h: number; // percentage
}

export interface OHLCVCandle {
  unixTime: number; // seconds
  o: number;        // open
  h: number;        // high
  l: number;        // low
  c: number;        // close
  v: number;        // volume (USD)
}

export interface TokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  priceChange24hPercent: number;
  v24hUSD: number;   // 24h volume in USD
  marketCap: number; // USD
  liquidity: number; // USD
  trade24h: number;  // number of trades in 24h
  holder: number;    // holder count
}

// ─── API calls ─────────────────────────────────────────────────────────────

/**
 * Get the current price + 24h change of a token.
 */
export async function getTokenPrice(mintAddress: string): Promise<TokenPrice> {
  const res = await client.get<{ data: TokenPrice }>('/defi/price', {
    params: { address: mintAddress, include_liquidity: false },
  });
  return res.data.data;
}

/**
 * Fetch the most recent N candles for a token (lightweight, single request).
 * Use this in the monitor loop — faster than getAllOHLCV.
 */
export async function getRecentOHLCV(
  mintAddress: string,
  interval: KlineInterval,
  limit = 20
): Promise<OHLCVCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - intervalToSeconds(interval) * limit;
  const res = await client.get<{ data: { items: OHLCVCandle[] } }>('/defi/ohlcv', {
    params: { address: mintAddress, type: interval, time_from: timeFrom, time_to: now },
  });
  return res.data.data.items ?? [];
}

/** Single-page OHLCV fetch (internal). Returns up to BATCH_SIZE candles ending at timeTo. */
const BATCH_SIZE = 1000;

async function fetchOHLCVPage(
  mintAddress: string,
  interval: KlineInterval,
  timeFrom: number,
  timeTo: number
): Promise<OHLCVCandle[]> {
  const res = await client.get<{ data: { items: OHLCVCandle[] } }>('/defi/ohlcv', {
    params: { address: mintAddress, type: interval, time_from: timeFrom, time_to: timeTo },
  });
  return res.data.data.items ?? [];
}

/**
 * Fetch ALL available OHLCV candles for a token by paginating backwards in time.
 *
 * Stops when a page returns fewer candles than BATCH_SIZE (no more history)
 * or when timeFrom reaches the absolute floor.
 *
 * @param mintAddress  Token mint address
 * @param interval     Candle interval, e.g. '1H' or '1D'
 * @param timeFloor    Unix timestamp (seconds) to stop at. Defaults to 2 years ago.
 */
export async function getAllOHLCV(
  mintAddress: string,
  interval: KlineInterval,
  timeFloor?: number
): Promise<OHLCVCandle[]> {
  const intervalSec = intervalToSeconds(interval);
  const floor = timeFloor ?? Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
  let timeTo = Math.floor(Date.now() / 1000);
  const allCandles: OHLCVCandle[] = [];

  while (true) {
    const timeFrom = Math.max(timeTo - intervalSec * BATCH_SIZE, floor);
    const page = await fetchOHLCVPage(mintAddress, interval, timeFrom, timeTo);

    if (page.length > 0) {
      allCandles.unshift(...page); // prepend — building chronological order
    }

    const reachedFloor = timeFrom <= floor;
    const noMoreData = page.length < BATCH_SIZE;

    if (reachedFloor || noMoreData) break;

    // Move window back; subtract 1s to avoid duplicating the boundary candle
    timeTo = page[0]!.unixTime - 1;

    // Rate-limit guard between pagination requests
    await sleep(1200);
  }

  // Deduplicate by unixTime (in case boundary candles overlap)
  const seen = new Set<number>();
  return allCandles.filter((c) => {
    if (seen.has(c.unixTime)) return false;
    seen.add(c.unixTime);
    return true;
  });
}

/**
 * Get a comprehensive overview of a token (metadata + market data).
 */
export async function getTokenOverview(mintAddress: string): Promise<TokenOverview> {
  const res = await client.get<{ data: TokenOverview }>('/defi/token_overview', {
    params: { address: mintAddress },
  });
  return res.data.data;
}

// ─── Derived helpers ───────────────────────────────────────────────────────

/**
 * Calculate the amplitude percentage of a single candle:
 *   (high - low) / open * 100
 */
export function candleAmplitude(candle: OHLCVCandle): number {
  return ((candle.h - candle.l) / candle.o) * 100;
}

/**
 * Calculate average amplitude over a list of candles.
 */
export function avgAmplitude(candles: OHLCVCandle[]): number {
  if (candles.length === 0) return 0;
  const total = candles.reduce((sum, c) => sum + candleAmplitude(c), 0);
  return total / candles.length;
}

/**
 * Calculate average volume over a list of candles.
 */
export function avgVolume(candles: OHLCVCandle[]): number {
  if (candles.length === 0) return 0;
  return candles.reduce((sum, c) => sum + c.v, 0) / candles.length;
}

// ─── Entry pre-conditions ──────────────────────────────────────────────────

export type TokenPath = 'mature' | 'young-small' | 'young-large';

export interface EntryPreConditions {
  passed: boolean;
  reason: string;
  athMarketCapUsd: number;
  currentMarketCapUsd: number;
  drawdownPct: number;
  ageDays: number;
  lowAmpBars: number;      // qualifying amplitude bars in the analysis window
  lowVolBars: number;      // qualifying volume bars in the analysis window
  volThresholdUsd: number;
  path: TokenPath;         // which branch was evaluated
}

// ── Shared ────────────────────────────────────────────────────────────────
const AGE_THRESHOLD_DAYS   = 40;

// ── Mature token path (age > 40 days, 1D candles) ─────────────────────────
const MATURE_DRAWDOWN_PCT  = 80;
const MATURE_WINDOW        = 10;   // last 10 daily candles
const MATURE_AMP_MIN       = 3;    // ≥ 3 candles with amplitude ≤ 15%
const MATURE_AMP_MAX_PCT   = 15;
const MATURE_VOL_MIN       = 3;    // ≥ 3 candles with volume < threshold
const MATURE_VOL_LOW_USD   = 10_000;
const MATURE_VOL_HIGH_USD  = 20_000;
const MATURE_ATH_BREAKPOINT = 100_000_000; // $100M — determines which vol threshold applies

// ── Young token path (age ≤ 40 days, 4H candles) ──────────────────────────
const YOUNG_DRAWDOWN_PCT      = 90;
const YOUNG_WINDOW            = 10;        // last 10 completed 4H bars
const YOUNG_ATH_BREAKPOINT    = 20_000_000; // $20M — determines which sub-tier applies

// Young / ATH MC ≤ $20M
const YOUNG_SMALL_AMP_MIN     = 4;    // ≥ 4 bars with amplitude < 10%
const YOUNG_SMALL_AMP_MAX_PCT = 10;
const YOUNG_SMALL_VOL_MIN     = 4;    // ≥ 4 bars with volume < $10k
const YOUNG_SMALL_VOL_USD     = 10_000;

// Young / ATH MC > $20M
const YOUNG_LARGE_AMP_MIN     = 4;    // ≥ 4 bars with amplitude < 20%
const YOUNG_LARGE_AMP_MAX_PCT = 20;
const YOUNG_LARGE_VOL_MIN     = 4;    // ≥ 4 bars with volume < $50k
const YOUNG_LARGE_VOL_USD     = 50_000;

/**
 * Smart full-history daily candle fetcher.
 *
 * Probes with a single 1000-candle request first. If we hit the limit it means
 * the token is older than ~1000 days and we paginate backwards until we have
 * the complete history (floor = 5 years ago).
 */
async function getFullDailyOHLCV(mintAddress: string): Promise<OHLCVCandle[]> {
  const probe = await getRecentOHLCV(mintAddress, '1D', BATCH_SIZE);
  if (probe.length < BATCH_SIZE) {
    return probe;  // All candles fit in one request
  }
  // Hit the limit — paginate backwards to get full history
  log('INFO', `[Birdeye] ${mintAddress.slice(0, 8)}… 日K达到 ${BATCH_SIZE} 根上限，开始分页获取全量历史`);
  const floor5yr = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
  return getAllOHLCV(mintAddress, '1D', floor5yr);
}

/**
 * Gate that runs BEFORE the main signal check.
 *
 * Mature token (age > 40 days) — 1D candles:
 *   1. ATH drawdown ≥ 80%
 *   2. ≥ 3 of last 10 daily candles with amplitude ≤ 15%
 *   3. ≥ 3 of last 10 daily candles with volume < $10k
 *      (relaxed to $20k when ATH MC was ≥ $100M)
 *
 * Young token (age ≤ 40 days) — 4H candles, ATH drawdown ≥ 90%:
 *   ATH MC > $20M  → ≥ 4 bars amp < 20%  AND ≥ 4 bars vol < $50k
 *   ATH MC ≤ $20M  → ≥ 4 bars amp < 10%  AND ≥ 4 bars vol < $10k
 */
export async function checkEntryPreConditions(
  mintAddress: string,
): Promise<EntryPreConditions> {
  // ── Birdeye 全部 key 耗尽 → 自动切换到备用数据栈 ────────────────────────
  if (isAllBirdeyeKeysExhausted()) {
    log('WARN', `[Birdeye] 全部 key 已耗尽，切换到备用数据栈 (DexScreener + GeckoTerminal)`);
    const { checkEntryPreConditions: fallback } = await import('./marketDataFallback');
    return fallback(mintAddress);
  }

  try {
  const overview = await getTokenOverview(mintAddress);
  const currentMarketCapUsd = overview.marketCap;
  const currentPrice = overview.price;

  // Daily candles needed for ATH calculation and age estimation
  const dailyCandles = await getFullDailyOHLCV(mintAddress);

  // ── ATH market cap & drawdown ─────────────────────────────────────────────
  const estimatedSupply = currentPrice > 0 ? currentMarketCapUsd / currentPrice : 0;
  const athPrice        = dailyCandles.reduce((max, c) => Math.max(max, c.h), 0);
  const athMarketCapUsd = athPrice * estimatedSupply;
  const drawdownPct     = athMarketCapUsd > 0
    ? ((athMarketCapUsd - currentMarketCapUsd) / athMarketCapUsd) * 100
    : 0;

  // ── Token age (days since first available daily candle) ───────────────────
  const firstCandleTime = dailyCandles.length > 0 ? dailyCandles[0]!.unixTime : Date.now() / 1000;
  const ageDays = (Date.now() / 1000 - firstCandleTime) / 86400;

  const isYoung = ageDays <= AGE_THRESHOLD_DAYS;
  const requiredDrawdown = isYoung ? YOUNG_DRAWDOWN_PCT : MATURE_DRAWDOWN_PCT;

  if (drawdownPct < requiredDrawdown) {
    return {
      passed: false,
      reason: `ATH drawdown ${drawdownPct.toFixed(1)}% < required ${requiredDrawdown}% (${isYoung ? 'young' : 'mature'} token)`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct,
      ageDays, lowAmpBars: 0, lowVolBars: 0, volThresholdUsd: 0,
      path: isYoung ? 'young-small' : 'mature',
    };
  }

  // ── Young token path: 4H candles ─────────────────────────────────────────
  if (isYoung) {
    const candles4h = await getRecentOHLCV(mintAddress, '4H', YOUNG_WINDOW + 1);
    // Exclude the current (potentially incomplete) bar
    const window4h  = candles4h.slice(-(YOUNG_WINDOW + 1), -1);

    // Sub-tier: ATH MC > $20M uses relaxed thresholds
    const isLargeYoung   = athMarketCapUsd > YOUNG_ATH_BREAKPOINT;
    const ampMinCount    = isLargeYoung ? YOUNG_LARGE_AMP_MIN     : YOUNG_SMALL_AMP_MIN;
    const ampMaxPct      = isLargeYoung ? YOUNG_LARGE_AMP_MAX_PCT : YOUNG_SMALL_AMP_MAX_PCT;
    const volMinCount    = isLargeYoung ? YOUNG_LARGE_VOL_MIN     : YOUNG_SMALL_VOL_MIN;
    const volThresholdUsd = isLargeYoung ? YOUNG_LARGE_VOL_USD    : YOUNG_SMALL_VOL_USD;
    const tier           = isLargeYoung ? 'large' : 'small';
    const path: TokenPath = isLargeYoung ? 'young-large' : 'young-small';

    const lowAmpBars = window4h.filter((c) => candleAmplitude(c) < ampMaxPct).length;
    // c.v is in token units — multiply by close price to get USD volume
    const lowVolBars = window4h.filter((c) => c.v * c.c < volThresholdUsd).length;

    if (lowAmpBars < ampMinCount) {
      return {
        passed: false,
        reason: `[Young-${tier}] Low-amp 4H bars ${lowAmpBars}/${ampMinCount} (< ${ampMaxPct}%) in last ${YOUNG_WINDOW} bars`,
        athMarketCapUsd, currentMarketCapUsd, drawdownPct,
        ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path,
      };
    }

    if (lowVolBars < volMinCount) {
      return {
        passed: false,
        reason: `[Young-${tier}] Low-vol 4H bars ${lowVolBars}/${volMinCount} (< $${volThresholdUsd.toLocaleString()}) in last ${YOUNG_WINDOW} bars`,
        athMarketCapUsd, currentMarketCapUsd, drawdownPct,
        ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path,
      };
    }

    return {
      passed: true, reason: 'OK',
      athMarketCapUsd, currentMarketCapUsd, drawdownPct,
      ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path,
    };
  }

  // ── Mature token path: 1D candles ─────────────────────────────────────────
  const window1d       = dailyCandles.slice(-(MATURE_WINDOW + 1), -1);
  const volThresholdUsd = athMarketCapUsd >= MATURE_ATH_BREAKPOINT ? MATURE_VOL_HIGH_USD : MATURE_VOL_LOW_USD;
  const lowAmpBars     = window1d.filter((c) => candleAmplitude(c) <= MATURE_AMP_MAX_PCT).length;
  // c.v is in token units — multiply by close price to get USD volume
  const lowVolBars     = window1d.filter((c) => c.v * c.c < volThresholdUsd).length;

  if (lowAmpBars < MATURE_AMP_MIN) {
    return {
      passed: false,
      reason: `Low-amp days ${lowAmpBars}/${MATURE_AMP_MIN} (≤${MATURE_AMP_MAX_PCT}%) in last ${MATURE_WINDOW}d`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct,
      ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature',
    };
  }

  if (lowVolBars < MATURE_VOL_MIN) {
    return {
      passed: false,
      reason: `Low-vol days ${lowVolBars}/${MATURE_VOL_MIN} (< $${volThresholdUsd.toLocaleString()}) in last ${MATURE_WINDOW}d`,
      athMarketCapUsd, currentMarketCapUsd, drawdownPct,
      ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature',
    };
  }

  return {
    passed: true, reason: 'OK',
    athMarketCapUsd, currentMarketCapUsd, drawdownPct,
    ageDays, lowAmpBars, lowVolBars, volThresholdUsd, path: 'mature',
  };
  } catch (err) {
    // ── 捕获 BirdeyeExhaustedError → 切换到备用数据栈 ─────────────────────
    if (err instanceof BirdeyeExhaustedError) {
      log('WARN', `[Birdeye] 所有 key 已耗尽，切换到备用数据栈`);
      const { checkEntryPreConditions: fallback } = await import('./marketDataFallback');
      return fallback(mintAddress);
    }
    throw err;
  }
}

/**
 * Detect a low-volatility + volume contraction pattern across the last N candles.
 *
 * Returns true when:
 *   - avg amplitude of last N candles < maxAmplitudePct
 *   - latest candle volume < avgVolume * volumeContractionRatio
 */
export function isLowVolContraction(
  candles: OHLCVCandle[],
  opts: {
    lookback?: number;           // how many candles to analyse (default 5)
    maxAmplitudePct?: number;    // e.g. 5 means < 5% swing (default 5)
    volumeContractionRatio?: number; // e.g. 0.7 means < 70% of avg (default 0.7)
  } = {}
): boolean {
  const { lookback = 5, maxAmplitudePct = 5, volumeContractionRatio = 0.7 } = opts;

  if (candles.length < lookback + 1) return false;

  const window = candles.slice(-lookback - 1, -1); // last N candles (excluding current)
  const latest = candles[candles.length - 1]!;

  const amp = avgAmplitude(window);
  const vol = avgVolume(window);

  const lowVolatility = amp < maxAmplitudePct;
  const volumeContracted = latest.v < vol * volumeContractionRatio;

  return lowVolatility && volumeContracted;
}

// ─── Error helper ──────────────────────────────────────────────────────────

export function isBirdeyeError(err: unknown): err is AxiosError {
  return axios.isAxiosError(err);
}

// ─── Internal ──────────────────────────────────────────────────────────────

function intervalToSeconds(interval: KlineInterval): number {
  const map: Record<KlineInterval, number> = {
    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
    '1H': 3600, '2H': 7200, '4H': 14400, '6H': 21600,
    '8H': 28800, '12H': 43200,
    '1D': 86400, '3D': 259200, '1W': 604800, '1M': 2592000,
  };
  return map[interval];
}
