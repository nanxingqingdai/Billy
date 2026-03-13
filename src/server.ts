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
import { isGeminiConfigured, answerQuery } from './services/gemini';
import { loadPositions } from './utils/positionStore';

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

  // 低振幅检查：最近 10 根已收盘 K 线中有几根符合振幅要求
  // 同时返回代币年龄、ATH 市值和推荐默认值
  app.get('/api/amp-check', async (req, res) => {
    const mint     = String(req.query['mint']     ?? '');
    const interval = String(req.query['interval'] ?? '1H');
    const ampPct   = parseFloat(String(req.query['ampPct'] ?? '5'));
    if (!mint) { res.status(400).json({ error: 'mint required' }); return; }
    try {
      const { getRecentOHLCV, getAllOHLCV } = await import('./services/geckoTerminal');
      const { getDexScreenerSummary }       = await import('./services/dexscreener');

      // 并发：当前K线 + 日K全量（判断年龄和ATH）+ DexScreener市值
      const [candles, dailyCandles, ds] = await Promise.all([
        getRecentOHLCV(mint, interval as any, 12),
        getRecentOHLCV(mint, '1D', 1000),
        getDexScreenerSummary(mint),
      ]);

      // 低振幅计数
      const closed = candles.slice(0, -1).slice(-10);
      const count  = closed.filter(c => c.o > 0 && ((c.h - c.l) / c.o) * 100 < ampPct).length;

      // 代币年龄
      const firstTs  = dailyCandles.length > 0 ? dailyCandles[0]!.unixTime : Date.now() / 1000;
      const ageDays  = (Date.now() / 1000 - firstTs) / 86400;

      // ATH 市值估算
      const athPrice        = dailyCandles.reduce((m, c) => Math.max(m, c.h), 0);
      const supply          = ds.priceUsd > 0 ? ds.marketCap / ds.priceUsd : 0;
      const athMarketCapUsd = athPrice * supply;

      // 推荐默认值
      let suggestAmpPct: number;
      let suggestMinBars: number;
      if (ageDays > 40) {
        suggestAmpPct  = 15;
        suggestMinBars = 3;
      } else if (athMarketCapUsd > 20_000_000) {
        suggestAmpPct  = 20;
        suggestMinBars = 4;
      } else {
        suggestAmpPct  = 10;
        suggestMinBars = 4;
      }

      res.json({ count, total: closed.length, ageDays, athMarketCapUsd, suggestAmpPct, suggestMinBars });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
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

    // AI Q&A handler
    socket.on('ai:query', async ({ question }: { question: string }) => {
      if (!isGeminiConfigured()) {
        socket.emit('bot:ai-reply', { answer: 'AI 助手未配置，请在 .env 中设置 GOOGLE_AI_API_KEY。', question, timestamp: new Date().toISOString() });
        return;
      }

      // Build context from live bot state
      const balance    = getLatest('bot:balance');
      const cycle      = getLatest('bot:cycle');
      const status     = getLatest('bot:status');
      const riskCfg    = getRiskConfig();
      const positions  = loadPositions();
      const watchlist  = getWatchlist();

      const posLines = positions.size > 0
        ? Array.from(positions.values()).map(p =>
            `  - ${p.symbol}: 开仓价 $${p.entryPrice.toFixed(6)}, 花费 $${p.usdtSpent} USDT`
          ).join('\n')
        : '  无持仓';

      const context = [
        `运行状态: ${status?.running ? '运行中' : '停止'} | DryRun: ${status?.dryRun ?? '未知'} | 运行时长: ${Math.floor((status?.uptimeSec ?? 0) / 60)} 分钟`,
        `SOL余额: ${balance?.solBalance?.toFixed(4) ?? '?'} SOL | USDT余额: $${balance?.usdtBalance?.toFixed(2) ?? '?'}`,
        `当前持仓 (${positions.size} 个):`,
        posLines,
        `监控代币: ${watchlist.map(t => t.symbol).join(', ') || '无'} (${watchlist.length} 个)`,
        `风控参数: 单笔最大买入 $${riskCfg.maxBuyUsdt} | 止损 ${riskCfg.stopLossPct}% | 最大持仓 ${riskCfg.maxOpenPositions} 个 | 每日最大亏损 $${riskCfg.maxDailyLossUsdt}`,
        `上次扫描: ${cycle ? `${cycle.tokenCount} 代币, ${cycle.positionCount} 持仓` : '尚未扫描'}`,
      ].join('\n');

      const answer = await answerQuery(question, context);
      socket.emit('bot:ai-reply', { answer, question, timestamp: new Date().toISOString() });
    });

    socket.on('disconnect', () => {
      log('INFO', `[Dashboard] Client disconnected: ${socket.id}`);
    });
  });

  const port = config.dashboardPort;
  return { httpServer, port };
}
