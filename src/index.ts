import { setupGlobalErrorHandlers } from './utils/errorHandler';
setupGlobalErrorHandlers(); // must be first

import { log } from './utils/logger';
import { config } from './config/env';
import { createAppServer } from './server';
import { startMonitor } from './monitor';
import { startMoonshotListener } from './services/moonshotListener';
import { notifyStartup, isTelegramConfigured } from './services/telegramNotifier';
import { getActiveTokens } from './config/watchlist';
import { startDailySummaryScheduler } from './services/dailySummary';
import { isGeminiConfigured } from './services/gemini';
import { isKimiConfigured } from './services/kimi';

async function main(): Promise<void> {
  log('INFO', '========================================');
  log('INFO', '  Solana Memecoin Quant Bot - Starting  ');
  log('INFO', '========================================');
  log('INFO', `RPC Endpoint : ${config.rpcUrl}`);
  log('INFO', `Birdeye Key  : ${config.birdeyeApiKey    ? '***set***' : '(not set)'}`);
  log('INFO', `Wallet Key   : ${config.walletPrivateKey ? '***set***' : '(not set)'}`);
  log('INFO', `Dry Run      : ${config.dryRun}`);
  log('INFO', `Max Buy USDT : $${config.maxBuyUsdt}`);
  log('INFO', `Interval     : ${config.monitorIntervalSec}s`);
  log('INFO', '');

  if (!config.walletPrivateKey) {
    log('ERROR', 'WALLET_PRIVATE_KEY is not set. Please fill in .env');
    process.exit(1);
  }
  if (!config.birdeyeApiKey) {
    log('ERROR', 'BIRDEYE_API_KEY is not set. Please fill in .env');
    process.exit(1);
  }

  // Start HTTP + Socket.io dashboard server
  const { httpServer, port } = createAppServer();
  httpServer.listen(port, () => {
    log('INFO', `Dashboard running at http://localhost:${port}`);
  });

  // Start Moonshot channel listener (auto-discovers new tokens)
  startMoonshotListener();

  // TG 启动通知
  if (isTelegramConfigured()) {
    await notifyStartup(getActiveTokens().length);
    log('INFO', 'Telegram notifier: configured ✅');
  } else {
    log('WARN', 'Telegram notifier: TG_BOT_TOKEN / TG_CHAT_ID not set — notifications disabled');
  }

  // Gemini AI
  if (isGeminiConfigured()) {
    log('INFO', 'Gemini AI: configured ✅ (signal analysis, token screening, daily summary, Q&A)');
    startDailySummaryScheduler();
  } else {
    log('WARN', 'Gemini AI: GOOGLE_AI_API_KEY not set — AI features disabled');
  }

  // Kimi AI
  if (isKimiConfigured()) {
    log('INFO', 'Kimi AI: configured ✅ (per-scan commentary, signal second opinion)');
  } else {
    log('WARN', 'Kimi AI: KIMI_API_KEY not set — Kimi features disabled');
  }

  // Start monitor loop
  await startMonitor();
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
