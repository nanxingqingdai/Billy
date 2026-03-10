import * as fs from 'fs';
import * as path from 'path';
import { KlineInterval } from '../services/birdeye';

export interface SellBatch {
  priceMultiplier: number; // e.g. 1.3 = sell at 130% of entry price
  portion: number;         // fraction of position to sell, e.g. 0.34
}

export interface SignalConfig {
  interval: KlineInterval;        // K-line interval to analyse, e.g. '1H'
  lookback: number;               // number of candles to look back
  maxAmplitudePct: number;        // max avg candle amplitude to qualify (e.g. 4 = 4%)
  volumeContractionRatio: number; // latest volume must be below avg * this ratio
}

export interface WatchlistToken {
  symbol: string;
  name: string;
  mint: string;
  active: boolean;
  maxBuyUsdt: number;   // max USDT to spend on this token per trade
  slippageBps: number;  // slippage tolerance for this token
  signal: SignalConfig;
  sellBatches: SellBatch[];
}

/**
 * Load and validate the watchlist from watchlist.json in the project root.
 * Only returns tokens where active = true.
 */
export function loadWatchlist(): WatchlistToken[] {
  const filePath = path.resolve(process.cwd(), 'watchlist.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`watchlist.json not found at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const all: WatchlistToken[] = JSON.parse(raw) as WatchlistToken[];

  const active = all.filter((t) => t.active);

  if (active.length === 0) {
    throw new Error('No active tokens in watchlist.json');
  }

  return active;
}
