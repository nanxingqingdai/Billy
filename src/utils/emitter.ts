import type { Server as SocketIOServer } from 'socket.io';
import type { WatchlistToken } from '../config/watchlist';

// ─── Typed event map ────────────────────────────────────────────────────────

export interface BotEvents {
  'bot:status':   { running: boolean; dryRun: boolean; uptimeSec: number };
  'bot:cycle':    { phase: 'start' | 'complete'; tokenCount: number; positionCount: number };
  'bot:price':    { symbol: string; mint: string; price: number; marketCap: number; change24h: number };
  'bot:signal':   { symbol: string; mint: string; price: number; marketCap: number };
  'bot:trade':    { type: 'buy' | 'sell'; symbol: string; mint: string; usdtAmount: number; price: number; txid: string; dryRun: boolean; batch?: number };
  'bot:position': { action: 'open' | 'update' | 'close'; symbol: string; mint: string; entryPrice: number; currentPrice: number; usdtSpent: number; pnlPct: number };
  'bot:risk':     { rule: string; symbol?: string; detail: string; blocked: boolean };
  'bot:error':    { level: 'error' | 'fatal'; message: string; timestamp: string };
  'bot:log':      { level: 'INFO' | 'WARN' | 'ERROR'; message: string; timestamp: string };
  'bot:config':   { config: Record<string, number>; errors?: string[] };
  'bot:balance':  { solBalance: number; usdtBalance: number };
  'bot:watchlist': { tokens: WatchlistToken[]; errors?: string[] };
  'bot:ai-reply':     { answer: string; question: string; timestamp: string };
  'bot:commentary':   { symbol: string; mint: string; text: string };
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _io: SocketIOServer | null = null;

// Cache latest payload for key events so new clients get immediate state
const _cache = new Map<string, unknown>();

export function registerIO(io: SocketIOServer): void {
  _io = io;
}

export function emit<K extends keyof BotEvents>(event: K, data: BotEvents[K]): void {
  _cache.set(event, data);
  _io?.emit(event, data);
}

export function getLatest<K extends keyof BotEvents>(event: K): BotEvents[K] | undefined {
  return _cache.get(event) as BotEvents[K] | undefined;
}
