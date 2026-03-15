import * as fs from 'fs';
import * as path from 'path';
import { KlineInterval } from '../services/birdeye';
import { log } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SellBatch {
  priceMultiplier: number; // e.g. 1.3 = sell at 130% of entry price
  portion: number;         // fraction of position to sell, e.g. 0.34
}

export interface SignalConfig {
  interval: KlineInterval;        // K-line interval to analyse, e.g. '1H'
  lookback: number;               // number of candles to look back (fixed 10)
  maxAmplitudePct: number;        // max candle amplitude to qualify (e.g. 4 = 4%)
  minLowAmpBars: number;          // min number of low-amp bars required out of last 10 (e.g. 6)
  volumeContractionRatio: number; // avg(last10) / avg(all) must be below this ratio
  maxVolPeakRatio: number;        // avg(last10) must be below max(all) * this ratio (e.g. 0.9)
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

export type TokenUpdate = Partial<Pick<WatchlistToken,
  'active' | 'maxBuyUsdt' | 'slippageBps' | 'sellBatches' | 'signal'
>>;

// ─── Persistence ────────────────────────────────────────────────────────────

const DATA_DIR        = path.resolve(process.cwd(), 'data');
const WATCHLIST_FILE  = path.join(DATA_DIR, 'watchlist.json');
const BLACKLIST_FILE  = path.join(DATA_DIR, 'watchlist-blacklist.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readFromDisk(): WatchlistToken[] {
  if (!fs.existsSync(WATCHLIST_FILE)) {
    throw new Error(`watchlist.json not found at ${WATCHLIST_FILE}`);
  }
  return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8')) as WatchlistToken[];
}

function saveToDisk(): void {
  try {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(_list, null, 2));
  } catch (e) {
    log('WARN', `[Watchlist] Failed to persist: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readBlacklist(): Set<string> {
  if (!fs.existsSync(BLACKLIST_FILE)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8')) as string[];
    return new Set(arr);
  } catch { return new Set(); }
}

function saveBlacklist(): void {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([..._blacklist], null, 2));
  } catch (e) {
    log('WARN', `[Watchlist] Failed to persist blacklist: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── In-memory state ────────────────────────────────────────────────────────

let _list: WatchlistToken[]  = readFromDisk();
let _blacklist: Set<string>  = readBlacklist();

// ─── Public read API ────────────────────────────────────────────────────────

/** Returns true if mint was manually removed and should not be auto-added again. */
export function isBlacklisted(mint: string): boolean {
  return _blacklist.has(mint);
}

/** All tokens including inactive — for dashboard display. */
export function getWatchlist(): WatchlistToken[] {
  return _list.map((t) => ({ ...t, sellBatches: [...t.sellBatches] }));
}

/** Only active tokens — called by the monitor each cycle. */
export function getActiveTokens(): WatchlistToken[] {
  return _list.filter((t) => t.active);
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/**
 * Update editable fields for an existing token.
 * Returns an errors array; empty array means success.
 */
export function updateToken(mint: string, updates: TokenUpdate): string[] {
  const idx = _list.findIndex((t) => t.mint === mint);
  if (idx === -1) return [`Token not found: ${mint}`];

  const errors: string[] = [];

  if (updates.maxBuyUsdt !== undefined) {
    if (updates.maxBuyUsdt <= 0 || updates.maxBuyUsdt > 100_000)
      errors.push('maxBuyUsdt must be between 1 and 100 000');
  }
  if (updates.slippageBps !== undefined) {
    if (updates.slippageBps < 10 || updates.slippageBps > 2_000)
      errors.push('slippageBps must be between 10 and 2 000');
  }
  if (updates.sellBatches !== undefined) {
    if (!Array.isArray(updates.sellBatches) || updates.sellBatches.length === 0)
      errors.push('sellBatches must be a non-empty array');
    else {
      const sum = updates.sellBatches.reduce((s, b) => s + b.portion, 0);
      if (Math.abs(sum - 1) > 0.011)
        errors.push(`Batch portions must sum to 1.0 (got ${sum.toFixed(3)})`);
    }
  }
  if (updates.signal !== undefined) {
    const s = updates.signal;
    if (s.lookback < 2 || s.lookback > 500)
      errors.push('signal.lookback must be between 2 and 500');
    if (s.maxAmplitudePct <= 0 || s.maxAmplitudePct > 100)
      errors.push('signal.maxAmplitudePct must be between 0 and 100');
    if (s.minLowAmpBars !== undefined && (s.minLowAmpBars < 1 || s.minLowAmpBars > 10))
      errors.push('signal.minLowAmpBars must be between 1 and 10');
    if (s.volumeContractionRatio <= 0 || s.volumeContractionRatio > 2)
      errors.push('signal.volumeContractionRatio must be between 0 and 2');
    if (s.maxVolPeakRatio !== undefined && (s.maxVolPeakRatio <= 0 || s.maxVolPeakRatio > 1))
      errors.push('signal.maxVolPeakRatio must be between 0 and 1');
  }

  if (errors.length > 0) return errors;

  _list[idx] = { ..._list[idx], ...updates };
  saveToDisk();
  log('INFO', `[Watchlist] ${_list[idx].symbol} updated`);
  return [];
}

/**
 * Add a brand-new token to the watchlist (manual — removes from blacklist).
 * Returns an errors array; empty array means success.
 */
export function addToken(token: WatchlistToken): string[] {
  if (!token.symbol?.trim()) return ['symbol is required'];
  if (!token.mint?.trim())   return ['mint address is required'];
  if (_list.some((t) => t.mint === token.mint))
    return [`Token with mint ${token.mint} already exists`];

  // Manual add overrides blacklist
  if (_blacklist.has(token.mint)) {
    _blacklist.delete(token.mint);
    saveBlacklist();
    log('INFO', `[Watchlist] ${token.mint} removed from blacklist (manual add)`);
  }

  _list.push(token);
  saveToDisk();
  log('INFO', `[Watchlist] ${token.symbol} added`);
  return [];
}

/**
 * Auto-add a token (e.g. from Dune sync). Skips if already in watchlist or blacklisted.
 * Returns 'added' | 'exists' | 'blacklisted'.
 */
export function addTokenAuto(token: WatchlistToken): 'added' | 'exists' | 'blacklisted' {
  if (_list.some((t) => t.mint === token.mint)) return 'exists';
  if (_blacklist.has(token.mint))               return 'blacklisted';

  _list.push(token);
  saveToDisk();
  log('INFO', `[Watchlist] [auto] ${token.symbol} (${token.mint.slice(0,8)}...) added`);
  return 'added';
}

/**
 * Remove a token by mint address.
 * @param addToBlacklist — if true, also blacklist to prevent auto re-add (default: false).
 * Returns an errors array; empty array means success.
 */
export function removeToken(mint: string, addToBlacklist = false): string[] {
  const idx = _list.findIndex((t) => t.mint === mint);
  if (idx === -1) return [`Token not found: ${mint}`];

  const symbol = _list[idx]!.symbol;
  _list.splice(idx, 1);
  saveToDisk();

  if (addToBlacklist) {
    _blacklist.add(mint);
    saveBlacklist();
    log('INFO', `[Watchlist] ${symbol} removed and blacklisted`);
  } else {
    log('INFO', `[Watchlist] ${symbol} removed (not blacklisted)`);
  }
  return [];
}

// ─── Backward-compat shim ───────────────────────────────────────────────────

/** @deprecated Use getActiveTokens() instead — this throws if nothing is active. */
export function loadWatchlist(): WatchlistToken[] {
  const active = getActiveTokens();
  if (active.length === 0) throw new Error('No active tokens in watchlist');
  return active;
}
