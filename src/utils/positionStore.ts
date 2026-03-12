import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Position {
  mint:         string;
  symbol:       string;
  entryPrice:   number;
  usdtSpent:    number;
  tokenBalance: number;
  decimals:     number;
  batchesSold:  Set<number>;   // in-memory
  boughtAt:     number;        // unix seconds
}

/** JSON-safe shape stored on disk (Set → plain array). */
interface PersistedPosition extends Omit<Position, 'batchesSold'> {
  batchesSold: number[];
}

// ─── File path ──────────────────────────────────────────────────────────────

const DATA_DIR   = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'positions.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Load ────────────────────────────────────────────────────────────────────

/**
 * Read positions.json from disk and return a live Map.
 * Returns an empty Map if the file doesn't exist or is corrupt.
 */
export function loadPositions(): Map<string, Position> {
  const map = new Map<string, Position>();

  if (!fs.existsSync(STORE_FILE)) return map;

  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const data = JSON.parse(raw) as PersistedPosition[];

    for (const p of data) {
      map.set(p.mint, { ...p, batchesSold: new Set(p.batchesSold) });
    }

    log('INFO', `[PositionStore] Restored ${map.size} position(s) from disk`);
  } catch (e) {
    log('WARN', `[PositionStore] Could not parse positions.json — starting fresh (${e instanceof Error ? e.message : String(e)})`);
  }

  return map;
}

// ─── Save ────────────────────────────────────────────────────────────────────

/**
 * Persist the current positions Map to disk.
 * Converts Set<number> → number[] for JSON compatibility.
 * Safe to call after every mutation — silently logs on error.
 */
export function savePositions(positions: Map<string, Position>): void {
  const data: PersistedPosition[] = Array.from(positions.values()).map((p) => ({
    ...p,
    batchesSold: Array.from(p.batchesSold),
  }));

  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('WARN', `[PositionStore] Failed to persist positions: ${e instanceof Error ? e.message : String(e)}`);
  }
}
