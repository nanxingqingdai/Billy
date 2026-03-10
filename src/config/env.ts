import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  rpcUrl:           process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  walletPrivateKey: process.env['WALLET_PRIVATE_KEY'] ?? '',
  birdeyeApiKey:    process.env['BIRDEYE_API_KEY'] ?? '',

  // Dashboard
  dashboardPort: Number(process.env['DASHBOARD_PORT'] ?? 3000),

  // Monitor loop
  monitorIntervalSec: Number(process.env['MONITOR_INTERVAL_SEC'] ?? 300),

  // Trade execution
  maxBuyUsdt:   Number(process.env['MAX_BUY_USDT']    ?? 50),
  slippageBps:  Number(process.env['SLIPPAGE_BPS']    ?? 100),
  dryRun:       (process.env['DRY_RUN'] ?? 'true') !== 'false',
};
