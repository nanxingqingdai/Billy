import * as path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { registerIO, getLatest } from './utils/emitter';
import { registerBroadcaster } from './utils/errorHandler';
import { log } from './utils/logger';
import { config } from './config/env';
import { getRiskConfig, updateRiskConfig, RISK_FIELDS } from './config/riskConfig';
import { getWatchlist, updateToken, addToken, removeToken, WatchlistToken } from './config/watchlist';
import { keypairFromBase58 } from './utils/keypair';
import { config as appConfig } from './config/env';
import QRCode from 'qrcode';

const walletAddress = appConfig.walletPrivateKey
  ? keypairFromBase58(appConfig.walletPrivateKey).publicKey.toBase58()
  : '';

let walletQrDataUrl = '';
if (walletAddress) {
  QRCode.toDataURL(walletAddress, { width: 200, margin: 1 })
    .then(url => { walletQrDataUrl = url; })
    .catch(() => {});
}

export function createAppServer(): { httpServer: ReturnType<typeof createServer>; port: number } {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  // Serve static frontend from /public
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Wire Socket.io into the emitter singleton
  registerIO(io);

  // Wire Socket.io into the global error handler
  registerBroadcaster((payload) => {
    io.emit('bot:error', payload);
  });

  io.on('connection', (socket) => {
    log('INFO', `[Dashboard] Client connected: ${socket.id}`);

    // Send wallet address + QR code immediately on connect
    socket.emit('bot:wallet', { address: walletAddress, qr: walletQrDataUrl });

    // Send current risk config + field metadata immediately on connect
    socket.emit('bot:config', { config: getRiskConfig() });
    socket.emit('bot:config:fields', RISK_FIELDS);

    // Send full watchlist on connect
    socket.emit('bot:watchlist', { tokens: getWatchlist() });

    // Push latest cached state so dashboard shows correct status immediately
    const lastStatus  = getLatest('bot:status');
    const lastBalance = getLatest('bot:balance');
    const lastCycle   = getLatest('bot:cycle');
    if (lastStatus)  socket.emit('bot:status',  lastStatus);
    if (lastBalance) socket.emit('bot:balance',  lastBalance);
    if (lastCycle)   socket.emit('bot:cycle',    lastCycle);

    // Watchlist handlers
    socket.on('watchlist:get', () => {
      socket.emit('bot:watchlist', { tokens: getWatchlist() });
    });

    socket.on('watchlist:update', ({ mint, updates }: { mint: string; updates: Partial<WatchlistToken> }) => {
      const errors = updateToken(mint, updates);
      if (errors.length > 0) {
        log('WARN', `[Dashboard] Watchlist update rejected: ${errors.join(', ')}`);
        socket.emit('bot:watchlist', { tokens: getWatchlist(), errors });
      } else {
        log('INFO', `[Dashboard] Watchlist updated — mint: ${mint}`);
        io.emit('bot:watchlist', { tokens: getWatchlist() });
      }
    });

    socket.on('watchlist:add', (token: WatchlistToken) => {
      const errors = addToken(token);
      if (errors.length > 0) {
        log('WARN', `[Dashboard] Add token rejected: ${errors.join(', ')}`);
        socket.emit('bot:watchlist', { tokens: getWatchlist(), errors });
      } else {
        log('INFO', `[Dashboard] Token added: ${token.symbol}`);
        io.emit('bot:watchlist', { tokens: getWatchlist() });
      }
    });

    socket.on('watchlist:remove', ({ mint }: { mint: string }) => {
      const errors = removeToken(mint);
      if (errors.length > 0) {
        log('WARN', `[Dashboard] Remove token rejected: ${errors.join(', ')}`);
        socket.emit('bot:watchlist', { tokens: getWatchlist(), errors });
      } else {
        log('INFO', `[Dashboard] Token removed: ${mint}`);
        io.emit('bot:watchlist', { tokens: getWatchlist() });
      }
    });

    // Client requests current config
    socket.on('config:get', () => {
      socket.emit('bot:config', { config: getRiskConfig() });
    });

    // Client submits config updates
    socket.on('config:update', (updates: Record<string, number>) => {
      const { config: newCfg, errors } = updateRiskConfig(updates);
      if (errors.length > 0) {
        log('WARN', `[Dashboard] Config update rejected: ${errors.join(', ')}`);
        socket.emit('bot:config', { config: newCfg, errors });
      } else {
        log('INFO', `[Dashboard] Risk config updated by dashboard`);
        // Broadcast to all clients so all open tabs stay in sync
        io.emit('bot:config', { config: newCfg });
      }
    });

    socket.on('disconnect', () => {
      log('INFO', `[Dashboard] Client disconnected: ${socket.id}`);
    });
  });

  const port = config.dashboardPort;
  return { httpServer, port };
}
