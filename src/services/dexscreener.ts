import axios from 'axios';

const BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DexPair {
  dexId: string;
  pairAddress: string;
  priceUsd: number;
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { h1: number; h6: number; h24: number };
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  pairCreatedAtMs: number; // unix milliseconds
}

export interface DexScreenerSummary {
  priceUsd: number;          // price from the highest-liquidity pair
  totalVolume24h: number;    // sum of all pairs' 24h volume
  totalLiquidityUsd: number; // sum of all pairs' liquidity
  marketCap: number;         // from highest-liquidity pair
  fdv: number;
  priceChange24h: number;
  earliestPairCreatedMs: number; // earliest pair = token launch estimate
  ageDays: number;               // days since earliest pair
  pairs: DexPair[];
}

// ─── Raw API response shape ────────────────────────────────────────────────

interface RawPair {
  dexId: string;
  pairAddress: string;
  priceUsd?: string;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

// ─── Main fetch function ───────────────────────────────────────────────────

/**
 * Fetch all DEX pairs for a Solana token and return an aggregated summary.
 * Filters out pairs with < $50 liquidity to ignore noise/dust pools.
 */
export async function getDexScreenerSummary(
  mintAddress: string,
): Promise<DexScreenerSummary> {
  const res = await axios.get<{ pairs: RawPair[] | null }>(
    `${BASE_URL}/${mintAddress}`,
    { timeout: 10_000 },
  );

  const raw = res.data.pairs ?? [];

  // Filter out dust pools
  const pairs: DexPair[] = raw
    .filter((p) => (p.liquidity?.usd ?? 0) >= 50)
    .map((p) => ({
      dexId:            p.dexId,
      pairAddress:      p.pairAddress,
      priceUsd:         parseFloat(p.priceUsd ?? '0'),
      volume: {
        h24: p.volume?.h24 ?? 0,
        h6:  p.volume?.h6  ?? 0,
        h1:  p.volume?.h1  ?? 0,
        m5:  p.volume?.m5  ?? 0,
      },
      priceChange: {
        h1:  p.priceChange?.h1  ?? 0,
        h6:  p.priceChange?.h6  ?? 0,
        h24: p.priceChange?.h24 ?? 0,
      },
      liquidityUsd:      p.liquidity?.usd   ?? 0,
      marketCap:         p.marketCap        ?? 0,
      fdv:               p.fdv              ?? 0,
      pairCreatedAtMs:   p.pairCreatedAt    ?? 0,
    }));

  if (pairs.length === 0) {
    return {
      priceUsd: 0, totalVolume24h: 0, totalLiquidityUsd: 0,
      marketCap: 0, fdv: 0, priceChange24h: 0,
      earliestPairCreatedMs: 0, ageDays: 0, pairs: [],
    };
  }

  // Highest-liquidity pair = the reference pair for price / market cap
  const refPair = [...pairs].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]!;

  const totalVolume24h    = pairs.reduce((s, p) => s + p.volume.h24,   0);
  const totalLiquidityUsd = pairs.reduce((s, p) => s + p.liquidityUsd, 0);

  const earliestPairCreatedMs = pairs.reduce(
    (min, p) => (p.pairCreatedAtMs > 0 && p.pairCreatedAtMs < min ? p.pairCreatedAtMs : min),
    Infinity,
  );
  const ageDays = earliestPairCreatedMs !== Infinity
    ? (Date.now() - earliestPairCreatedMs) / 86_400_000
    : 0;

  return {
    priceUsd:               refPair.priceUsd,
    totalVolume24h,
    totalLiquidityUsd,
    marketCap:              refPair.marketCap,
    fdv:                    refPair.fdv,
    priceChange24h:         refPair.priceChange.h24,
    earliestPairCreatedMs:  earliestPairCreatedMs === Infinity ? 0 : earliestPairCreatedMs,
    ageDays,
    pairs,
  };
}

// ─── Cross-validation helper ───────────────────────────────────────────────

export interface DataValidationResult {
  priceMatch:    boolean;  // within 5%
  volumeMatch:   boolean;  // within 20%
  ageDaysDS:     number;   // age from DexScreener (more accurate)
  priceDiffPct:  number;
  volumeDiffPct: number;
  warnings:      string[];
}

/**
 * Compare Birdeye data against DexScreener for sanity checking.
 *
 * @param birdeyePrice     current price from Birdeye getTokenPrice()
 * @param birdeyeVol24h    24h volume from Birdeye getTokenOverview().v24hUSD
 * @param ds               DexScreener summary
 */
export function crossValidate(
  birdeyePrice:   number,
  birdeyeVol24h:  number,
  ds:             DexScreenerSummary,
): DataValidationResult {
  const warnings: string[] = [];

  const priceDiffPct = ds.priceUsd > 0
    ? Math.abs(birdeyePrice - ds.priceUsd) / ds.priceUsd * 100
    : 0;

  const volumeDiffPct = ds.totalVolume24h > 0
    ? Math.abs(birdeyeVol24h - ds.totalVolume24h) / ds.totalVolume24h * 100
    : 0;

  const priceMatch  = priceDiffPct  <= 5;
  const volumeMatch = volumeDiffPct <= 20;

  if (!priceMatch)
    warnings.push(`Price mismatch: Birdeye $${birdeyePrice.toFixed(8)} vs DexScreener $${ds.priceUsd.toFixed(8)} (${priceDiffPct.toFixed(1)}% diff)`);
  if (!volumeMatch)
    warnings.push(`Volume mismatch: Birdeye $${birdeyeVol24h.toFixed(0)} vs DexScreener $${ds.totalVolume24h.toFixed(0)} (${volumeDiffPct.toFixed(1)}% diff)`);

  return { priceMatch, volumeMatch, ageDaysDS: ds.ageDays, priceDiffPct, volumeDiffPct, warnings };
}
