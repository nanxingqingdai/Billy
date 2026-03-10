import { log } from './logger';

// ─── Broadcaster interface ─────────────────────────────────────────────────
//
// When the Socket.io frontend is built, call registerBroadcaster() to wire
// the error handler into it. Until then, errors are only logged locally.

export interface ErrorPayload {
  level: 'error' | 'fatal';
  message: string;
  stack?: string;
  timestamp: string;
}

type BroadcastFn = (payload: ErrorPayload) => void;

let _broadcaster: BroadcastFn | null = null;

/**
 * Register a Socket.io (or any) broadcaster.
 * Call this once after the Socket.io server is initialised.
 *
 * Example (future frontend integration):
 *   import { registerBroadcaster } from './utils/errorHandler';
 *   registerBroadcaster((payload) => io.emit('bot:error', payload));
 */
export function registerBroadcaster(fn: BroadcastFn): void {
  _broadcaster = fn;
}

// ─── Core broadcast helper ─────────────────────────────────────────────────

function broadcast(error: Error, fatal: boolean): void {
  const payload: ErrorPayload = {
    level: fatal ? 'fatal' : 'error',
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  };

  // Always log locally
  log('ERROR', `[${payload.level.toUpperCase()}] ${error.message}`);
  if (fatal && error.stack) log('ERROR', error.stack);

  // Forward to frontend if broadcaster is registered
  if (_broadcaster) {
    try {
      _broadcaster(payload);
    } catch {
      // Never let the broadcaster crash the error handler itself
    }
  }
}

// ─── Global handlers ───────────────────────────────────────────────────────

/**
 * Set up process-level error handlers.
 * Call this once at the very start of src/index.ts, before anything else.
 */
export function setupGlobalErrorHandlers(): void {
  // Synchronous uncaught exceptions — usually unrecoverable
  process.on('uncaughtException', (err: Error) => {
    broadcast(err, /* fatal */ true);
    // Give Socket.io a brief window to emit before PM2 restarts the process
    setTimeout(() => process.exit(1), 500);
  });

  // Unhandled promise rejections — log but don't crash
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    broadcast(err, /* fatal */ false);
  });

  // Graceful shutdown on SIGTERM (PM2 stop / restart)
  process.on('SIGTERM', () => {
    log('INFO', 'SIGTERM received — shutting down gracefully');
    process.exit(0);
  });
}
