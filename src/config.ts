import dotenv from 'dotenv';
import { MonitorConfig, KlineType, WatchToken } from './types';

dotenv.config();

export function loadConfig(): MonitorConfig {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey || apiKey === 'your_birdeye_api_key_here') {
    console.error('ERROR: Please set BIRDEYE_API_KEY in .env file');
    console.error('Get your API key from https://birdeye.so/developers');
    process.exit(1);
  }

  return {
    birdeyeApiKey: apiKey,
    monitorInterval: parseInt(process.env.MONITOR_INTERVAL || '300', 10),
    klineType: (process.env.KLINE_TYPE || '1H') as KlineType,
    candleCount: parseInt(process.env.CANDLE_COUNT || '3', 10),
    maxAmplitudePct: parseFloat(process.env.MAX_AMPLITUDE_PCT || '10'),
  };
}

/**
 * Load watchlist from watchlist.json.
 * You can edit this file at any time - it's re-read on each monitor cycle.
 */
export function loadWatchlist(): WatchToken[] {
  // Clear require cache so file changes are picked up without restart
  const watchlistPath = require.resolve('../../watchlist.json');
  delete require.cache[watchlistPath];

  try {
    const data = require(watchlistPath);
    if (!Array.isArray(data.tokens)) {
      throw new Error('watchlist.json must have a "tokens" array');
    }
    return data.tokens;
  } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.error('ERROR: watchlist.json not found. Please create it.');
      console.error('See watchlist.example.json for format.');
      process.exit(1);
    }
    throw error;
  }
}
