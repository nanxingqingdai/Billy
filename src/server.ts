import * as path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { registerIO } from './utils/emitter';
import { registerBroadcaster } from './utils/errorHandler';
import { log } from './utils/logger';
import { config } from './config/env';
import { getRiskConfig, updateRiskConfig, RISK_FIELDS } from './config/riskConfig';

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

    // Send current risk config + field metadata immediately on connect
    socket.emit('bot:config', { config: getRiskConfig() });
    socket.emit('bot:config:fields', RISK_FIELDS);

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
