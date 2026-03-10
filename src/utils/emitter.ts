import type { Server as SocketIOServer } from 'socket.io';

// ─── Typed event map ────────────────────────────────────────────────────────

export interface BotEvents {
  'bot:status':   { running: boolean; dryRun: boolean; uptimeSec: number };
  'bot:cycle':    { phase: 'start' | 'complete'; tokenCount: number; positionCount: number };
  'bot:price':    { symbol: string; mint: string; price: number; change24h: number };
  'bot:signal':   { symbol: string; mint: string; price: number };
  'bot:trade':    { type: 'buy' | 'sell'; symbol: string; mint: string; usdtAmount: number; price: number; txid: string; dryRun: boolean; batch?: number };
  'bot:position': { action: 'open' | 'update' | 'close'; symbol: string; mint: string; entryPrice: number; currentPrice: number; usdtSpent: number; pnlPct: number };
  'bot:error':    { level: 'error' | 'fatal'; message: string; timestamp: string };
  'bot:log':      { level: 'INFO' | 'WARN' | 'ERROR'; message: string; timestamp: string };
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _io: SocketIOServer | null = null;

export function registerIO(io: SocketIOServer): void {
  _io = io;
}

export function emit<K extends keyof BotEvents>(event: K, data: BotEvents[K]): void {
  _io?.emit(event, data);
}
