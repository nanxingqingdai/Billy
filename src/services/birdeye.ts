import axios, { AxiosError } from 'axios';
import { config } from '../config/env';

const BASE_URL = 'https://public-api.birdeye.so';

// ─── Shared HTTP client ────────────────────────────────────────────────────

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 10_000,
  headers: {
    'X-API-KEY': config.birdeyeApiKey,
    'x-chain': 'solana',
  },
});

// Auto-retry on 429 (rate limit) and ECONNRESET (dropped keep-alive connection)
client.interceptors.response.use(
  (res) => res,
  async (err: unknown) => {
    if (!axios.isAxiosError(err) || !err.config) throw err;

    const cfg = err.config as typeof err.config & { _retryCount?: number };
    const retryCount = cfg._retryCount ?? 0;
    if (retryCount >= 3) throw err;

    const status = err.response?.status;
    const code = err.code;

    if (status === 429) {
      const retryAfter = Number(err.response?.headers['retry-after'] ?? 1);
      await sleep(retryAfter * 1000 + 500);
      cfg._retryCount = retryCount + 1;
      return client.request(cfg);
    }

    if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      await sleep(1500 * (retryCount + 1)); // back-off: 1.5s, 3s, 4.5s
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
  const floor = timeFloor ?? Math.floor(Date.now() / 1000) - 2 * 365 * 86400;
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
