import axios from 'axios';
import { Candle, KlineType } from '../types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

/**
 * Fetch OHLCV candle data from Birdeye API V1.
 * Endpoint: GET /defi/ohlcv
 *
 * @param tokenAddress - SPL token mint address
 * @param klineType - Candle interval (e.g. "1H", "1D")
 * @param candleCount - Number of candles to fetch
 * @param apiKey - Birdeye API key
 */
export async function fetchOHLCV(
  tokenAddress: string,
  klineType: KlineType,
  candleCount: number,
  apiKey: string,
): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const intervalSeconds = getIntervalSeconds(klineType);
  // Fetch a bit more data to ensure we have enough candles
  const timeFrom = now - intervalSeconds * (candleCount + 2);

  const url = `${BIRDEYE_BASE}/defi/ohlcv`;

  try {
    const response = await axios.get(url, {
      params: {
        address: tokenAddress,
        type: klineType,
        time_from: timeFrom,
        time_to: now,
      },
      headers: {
        'X-API-KEY': apiKey,
        accept: 'application/json',
      },
      timeout: 15000,
    });

    const data = response.data;

    if (!data.success || !data.data?.items) {
      throw new Error(`Birdeye API error: ${JSON.stringify(data)}`);
    }

    const candles: Candle[] = data.data.items.map((item: any) => ({
      timestamp: item.unixTime,
      open: item.o,
      high: item.h,
      low: item.l,
      close: item.c,
      volume: item.v,
    }));

    // Sort by timestamp ascending and take the latest `candleCount` candles
    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles.slice(-candleCount);
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const msg = error.response?.data?.message || error.message;
      throw new Error(`Birdeye API request failed (HTTP ${status}): ${msg}`);
    }
    throw error;
  }
}

/**
 * Get the current price of a token from Birdeye.
 */
export async function fetchCurrentPrice(
  tokenAddress: string,
  apiKey: string,
): Promise<number> {
  const url = `${BIRDEYE_BASE}/defi/price`;

  const response = await axios.get(url, {
    params: { address: tokenAddress },
    headers: {
      'X-API-KEY': apiKey,
      accept: 'application/json',
    },
    timeout: 10000,
  });

  const data = response.data;
  if (!data.success || !data.data?.value) {
    throw new Error(`Failed to fetch price for ${tokenAddress}`);
  }

  return data.data.value;
}

function getIntervalSeconds(klineType: KlineType): number {
  const map: Record<KlineType, number> = {
    '1H': 3600,
    '2H': 7200,
    '4H': 14400,
    '6H': 21600,
    '8H': 28800,
    '12H': 43200,
    '1D': 86400,
    '3D': 259200,
    '1W': 604800,
  };
  return map[klineType];
}
