import * as path from 'path';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { registerIO } from './utils/emitter';
import { registerBroadcaster } from './utils/errorHandler';
import { log } from './utils/logger';
import { config } from './config/env';

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
    socket.on('disconnect', () => {
      log('INFO', `[Dashboard] Client disconnected: ${socket.id}`);
    });
  });

  const port = config.dashboardPort;
  return { httpServer, port };
}
