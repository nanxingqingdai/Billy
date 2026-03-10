import { Candle, CandleWithAmplitude, BuySignal, WatchToken, MonitorConfig } from '../types';
import { fetchOHLCV, fetchCurrentPrice } from './ohlcv';
import { log } from '../utils/logger';

/**
 * Calculate the amplitude percentage of a candle.
 * Amplitude = (high - low) / low * 100
 *
 * This measures how much price swung within the candle period.
 * A small amplitude means the price was stable (consolidating).
 */
function calcAmplitude(candle: Candle): CandleWithAmplitude {
  const amplitudePct = candle.low > 0
    ? ((candle.high - candle.low) / candle.low) * 100
    : 0;
  return { ...candle, amplitudePct };
}

/**
 * Check if a token meets the low-volatility buy signal criteria:
 * - Last N consecutive candles all have amplitude < maxAmplitudePct
 * - This indicates price consolidation with low volatility
 *
 * Returns a BuySignal if criteria met, null otherwise.
 */
export async function detectBuySignal(
  token: WatchToken,
  config: MonitorConfig,
): Promise<BuySignal | null> {
  try {
    // Fetch recent candles
    const candles = await fetchOHLCV(
      token.address,
      config.klineType,
      config.candleCount,
      config.birdeyeApiKey,
    );

    if (candles.length < config.candleCount) {
      log.warn(`${token.symbol}: Only got ${candles.length}/${config.candleCount} candles, skipping`);
      return null;
    }

    // Calculate amplitude for each candle
    const analyzed = candles.map(calcAmplitude);

    // Check if ALL candles meet the low-volatility criteria
    const allLowVolatility = analyzed.every(c => c.amplitudePct < config.maxAmplitudePct);

    if (!allLowVolatility) {
      const amplitudes = analyzed.map(c => c.amplitudePct.toFixed(2) + '%');
      log.info(`${token.symbol}: Amplitudes [${amplitudes.join(', ')}] - no signal`);
      return null;
    }

    // Signal detected! Fetch current price
    const currentPrice = await fetchCurrentPrice(token.address, config.birdeyeApiKey);

    const avgAmplitudePct = analyzed.reduce((sum, c) => sum + c.amplitudePct, 0) / analyzed.length;
    const avgVolume = analyzed.reduce((sum, c) => sum + c.volume, 0) / analyzed.length;

    const signal: BuySignal = {
      type: 'LOW_VOLATILITY_BUY',
      token,
      candles: analyzed,
      avgAmplitudePct,
      avgVolume,
      currentPrice,
      detectedAt: Date.now(),
    };

    return signal;
  } catch (error: any) {
    log.error(`${token.symbol}: Error detecting signal - ${error.message}`);
    return null;
  }
}

/**
 * Format a buy signal into a readable string for logging/alerting.
 */
export function formatSignal(signal: BuySignal): string {
  const lines = [
    ``,
    `🚨 ═══════════════════════════════════════`,
    `   BUY SIGNAL DETECTED: ${signal.token.symbol}`,
    `═══════════════════════════════════════`,
    `  Address:   ${signal.token.address}`,
    `  Price:     $${signal.currentPrice.toPrecision(6)}`,
    `  Avg Amp:   ${signal.avgAmplitudePct.toFixed(2)}%`,
    `  Avg Vol:   $${signal.avgVolume.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `  Candles:`,
  ];

  for (const c of signal.candles) {
    const time = new Date(c.timestamp * 1000).toISOString().slice(0, 16);
    lines.push(
      `    ${time} | Amp: ${c.amplitudePct.toFixed(2)}% | Vol: $${c.volume.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    );
  }

  // Projected sell targets
  lines.push(`  ─────────────────────────────────────`);
  lines.push(`  Sell Targets (5x-20x):`);
  for (const mult of [5, 8, 10, 15, 20]) {
    lines.push(`    ${mult}x → $${(signal.currentPrice * mult).toPrecision(6)}`);
  }
  lines.push(`═══════════════════════════════════════\n`);

  return lines.join('\n');
}
