/**
 * Strategy: Batched Limit-Price Sell
 *
 * Exit logic:
 *   - Split the position into N batches.
 *   - Each batch has a target price multiplier (e.g. 1.3x, 1.6x, 2x).
 *   - Sell each batch when the current price crosses its target.
 *
 * This is a stub — wire in real data and execution via src/services/jupiter.ts.
 */

export interface SellBatch {
  priceMultiplier: number; // e.g. 1.3 = sell at 130% of entry
  portion: number;         // fraction of total position, e.g. 0.33
}

export const DEFAULT_SELL_BATCHES: SellBatch[] = [
  { priceMultiplier: 1.3, portion: 0.34 },
  { priceMultiplier: 1.6, portion: 0.33 },
  { priceMultiplier: 2.0, portion: 0.33 },
];

export function getBatchesToExecute(
  entryPrice: number,
  currentPrice: number,
  batches: SellBatch[],
  executedMultipliers: Set<number>
): SellBatch[] {
  return batches.filter(
    (b) =>
      currentPrice >= entryPrice * b.priceMultiplier &&
      !executedMultipliers.has(b.priceMultiplier)
  );
}
