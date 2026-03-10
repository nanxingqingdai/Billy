import { log } from './utils/logger';
import { config } from './config/env';

async function main(): Promise<void> {
  log('INFO', '========================================');
  log('INFO', '  Solana Memecoin Quant Bot - Starting  ');
  log('INFO', '========================================');
  log('INFO', `RPC Endpoint : ${config.rpcUrl}`);
  log('INFO', `Birdeye Key  : ${config.birdeyeApiKey ? '***set***' : '(not set)'}`);
  log('INFO', `Wallet Key   : ${config.walletPrivateKey ? '***set***' : '(not set)'}`);
  log('INFO', 'All modules loaded. Ready to trade.');
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
