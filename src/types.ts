// ===== K-Line / OHLCV Types =====

export interface Candle {
  /** Unix timestamp (seconds) */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Trading volume in USD */
  volume: number;
}

/** Amplitude = (high - low) / low * 100 */
export interface CandleWithAmplitude extends Candle {
  amplitudePct: number;
}

// ===== Watchlist Types =====

export interface WatchToken {
  /** Token mint address */
  address: string;
  /** Token symbol for display */
  symbol: string;
  /** Optional notes */
  note?: string;
}

// ===== Signal Types =====

export type SignalType = 'LOW_VOLATILITY_BUY';

export interface BuySignal {
  type: SignalType;
  token: WatchToken;
  /** The candles that triggered the signal */
  candles: CandleWithAmplitude[];
  /** Average amplitude of the trigger candles */
  avgAmplitudePct: number;
  /** Average volume of the trigger candles */
  avgVolume: number;
  /** Current price at signal time */
  currentPrice: number;
  /** Timestamp when signal was detected */
  detectedAt: number;
}

// ===== Config Types =====

export type KlineType = '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | '3D' | '1W';

export interface MonitorConfig {
  /** Birdeye API key */
  birdeyeApiKey: string;
  /** Monitor interval in seconds */
  monitorInterval: number;
  /** K-line timeframe */
  klineType: KlineType;
  /** Number of consecutive candles to check */
  candleCount: number;
  /** Maximum amplitude percentage to trigger signal */
  maxAmplitudePct: number;
}
