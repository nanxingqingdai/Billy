/**
 * Strategy: Low-Volatility Accumulation Buy
 *
 * Entry logic:
 *   - Monitor a token's price over a rolling window.
 *   - When price volatility (stddev / mean) drops below the threshold
 *     AND volume contracts below the volume threshold, trigger a buy signal.
 *
 * This is a stub — wire in real data from src/services/birdeye.ts.
 */

export interface StrategyConfig {
  volatilityThreshold: number; // e.g. 0.02 = 2%
  volumeContractRatio: number; // e.g. 0.5  = volume < 50% of avg
  buyAmountUsd: number;
}

export function shouldBuy(
  prices: number[],
  currentVolume: number,
  avgVolume: number,
  strategyConfig: StrategyConfig
): boolean {
  if (prices.length < 2) return false;

  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  const stddev = Math.sqrt(variance);
  const volatility = stddev / mean;

  const volumeContracted = currentVolume < avgVolume * strategyConfig.volumeContractRatio;
  const lowVolatility = volatility < strategyConfig.volatilityThreshold;

  return lowVolatility && volumeContracted;
}
