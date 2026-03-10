import * as fs from 'fs';
import * as path from 'path';
import { config as env } from './env';

// ─── Schema ────────────────────────────────────────────────────────────────

export interface RiskConfig {
  // Trade sizing
  maxBuyUsdt:        number;   // max USDT per trade
  slippageBps:       number;   // slippage tolerance

  // Position risk
  stopLossPct:       number;   // sell all if price drops X% from entry
  maxOpenPositions:  number;   // max simultaneous holdings
  maxHoldHours:      number;   // force-sell after X hours

  // Portfolio risk
  maxDailyLossUsdt:  number;   // pause buying if lost $X today
  minUsdtReserve:    number;   // always keep $X untouched

  // Execution quality
  maxPriceImpactPct: number;   // reject swap if Jupiter impact > X%
}

// ─── Field metadata (used by dashboard to build the form) ──────────────────

export interface RiskField {
  key:         keyof RiskConfig;
  label:       string;
  unit:        string;
  min:         number;
  max:         number;
  step:        number;
  description: string;
}

export const RISK_FIELDS: RiskField[] = [
  { key: 'maxBuyUsdt',        label: 'Max Buy Per Trade',    unit: 'USDT',  min: 1,   max: 10000, step: 1,    description: 'Maximum USDT to spend on a single buy trade' },
  { key: 'slippageBps',       label: 'Slippage Tolerance',   unit: 'bps',   min: 10,  max: 1000,  step: 10,   description: '100 = 1%, 300 = 3%. Higher = more likely to fill but worse price' },
  { key: 'stopLossPct',       label: 'Stop Loss',            unit: '%',     min: 1,   max: 95,    step: 0.5,  description: 'Sell entire position if price drops this % below entry' },
  { key: 'maxOpenPositions',  label: 'Max Open Positions',   unit: '',      min: 1,   max: 20,    step: 1,    description: 'Block new buys when this many positions are already open' },
  { key: 'maxHoldHours',      label: 'Max Hold Duration',    unit: 'h',     min: 1,   max: 720,   step: 1,    description: 'Force-sell position after this many hours if no target hit' },
  { key: 'maxDailyLossUsdt',  label: 'Daily Loss Cap',       unit: 'USDT',  min: 1,   max: 100000,step: 10,   description: 'Pause all buying for today if total realised loss exceeds this' },
  { key: 'minUsdtReserve',    label: 'Min USDT Reserve',     unit: 'USDT',  min: 0,   max: 10000, step: 5,    description: 'Always keep at least this much USDT in wallet — never spend it' },
  { key: 'maxPriceImpactPct', label: 'Max Price Impact',     unit: '%',     min: 0.1, max: 20,    step: 0.1,  description: 'Reject Jupiter swap quote if price impact exceeds this %' },
];

// ─── Persistence ───────────────────────────────────────────────────────────

const CONFIG_FILE = path.resolve(process.cwd(), 'risk-config.json');

function envDefaults(): RiskConfig {
  return {
    maxBuyUsdt:        env.maxBuyUsdt,
    slippageBps:       env.slippageBps,
    stopLossPct:       env.stopLossPct,
    maxOpenPositions:  env.maxOpenPositions,
    maxHoldHours:      env.maxHoldHours,
    maxDailyLossUsdt:  env.maxDailyLossUsdt,
    minUsdtReserve:    env.minUsdtReserve,
    maxPriceImpactPct: env.maxPriceImpactPct,
  };
}

function loadFromDisk(): RiskConfig {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<RiskConfig>;
      return { ...envDefaults(), ...saved };   // saved values override env defaults
    } catch {
      // corrupt file — fall back to env defaults
    }
  }
  return envDefaults();
}

let _cfg: RiskConfig = loadFromDisk();

// ─── Public API ────────────────────────────────────────────────────────────

/** Returns a copy of the current runtime risk config. */
export function getRiskConfig(): RiskConfig {
  return { ..._cfg };
}

/**
 * Apply a partial update, persist to disk, return the new full config.
 * Validates each field against RISK_FIELDS min/max bounds.
 */
export function updateRiskConfig(updates: Partial<RiskConfig>): { config: RiskConfig; errors: string[] } {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(updates) as [keyof RiskConfig, number][]) {
    const field = RISK_FIELDS.find((f) => f.key === key);
    if (!field) { errors.push(`Unknown field: ${key}`); continue; }
    if (typeof value !== 'number' || isNaN(value)) { errors.push(`${field.label}: must be a number`); continue; }
    if (value < field.min) { errors.push(`${field.label}: minimum is ${field.min}`); continue; }
    if (value > field.max) { errors.push(`${field.label}: maximum is ${field.max}`); continue; }
  }

  if (errors.length > 0) return { config: getRiskConfig(), errors };

  _cfg = { ..._cfg, ...updates };

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cfg, null, 2));
  } catch (e) {
    errors.push(`Failed to persist config: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { config: { ..._cfg }, errors };
}
