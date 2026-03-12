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
  { key: 'maxBuyUsdt',        label: '单笔最大买入',   unit: 'USDT', min: 1,   max: 10000,  step: 1,   description: '每次买入最多花费的 USDT 金额' },
  { key: 'slippageBps',       label: '滑点容忍度',     unit: 'bps',  min: 10,  max: 1000,   step: 10,  description: '100 = 1%，300 = 3%。越高越容易成交，但成交价格越差' },
  { key: 'stopLossPct',       label: '止损比例',       unit: '%',    min: 1,   max: 95,     step: 0.5, description: '价格从开仓价下跌超过此比例时，自动清仓止损' },
  { key: 'maxOpenPositions',  label: '最大持仓数量',   unit: '个',   min: 1,   max: 20,     step: 1,   description: '同时持有的代币数量上限，超过则暂停新买入' },
  { key: 'maxHoldHours',      label: '最长持仓时间',   unit: '小时', min: 1,   max: 720,    step: 1,   description: '持仓超过此时长仍未达到目标价，自动强制卖出' },
  { key: 'maxDailyLossUsdt',  label: '每日最大亏损',   unit: 'USDT', min: 1,   max: 100000, step: 10,  description: '当天累计亏损超过此金额，暂停当日所有买入操作' },
  { key: 'minUsdtReserve',    label: 'USDT 最低保留',  unit: 'USDT', min: 0,   max: 10000,  step: 5,   description: '钱包中始终保留的 USDT 底仓，不参与任何交易' },
  { key: 'maxPriceImpactPct', label: '最大价格冲击',   unit: '%',    min: 0.1, max: 20,     step: 0.1, description: 'Jupiter 报价的价格冲击超过此值时，拒绝执行交易' },
];

// ─── Persistence ───────────────────────────────────────────────────────────

const DATA_DIR    = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'risk-config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

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
