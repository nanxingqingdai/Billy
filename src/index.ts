import { log } from './utils/logger';
import { config } from './config/env';
import { startMonitor } from './monitor';

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

  await startMonitor();
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
