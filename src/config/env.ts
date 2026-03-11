import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  rpcUrl:           process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  walletPrivateKey: process.env['WALLET_PRIVATE_KEY'] ?? '',
  // 支持逗号分隔多个 key: BIRDEYE_API_KEY=key1,key2,key3
  birdeyeApiKey:  (process.env['BIRDEYE_API_KEY'] ?? '').split(',')[0]?.trim() ?? '',
  birdeyeApiKeys: (process.env['BIRDEYE_API_KEY'] ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean),

  // Dashboard
  dashboardPort: Number(process.env['DASHBOARD_PORT'] ?? 3000),

  // Monitor loop
  monitorIntervalSec: Number(process.env['MONITOR_INTERVAL_SEC'] ?? 300),

  // Trade execution
  maxBuyUsdt:   Number(process.env['MAX_BUY_USDT']    ?? 50),
  slippageBps:  Number(process.env['SLIPPAGE_BPS']    ?? 100),
  dryRun:       (process.env['DRY_RUN'] ?? 'true') !== 'false',

  // Risk management
  stopLossPct:          Number(process.env['STOP_LOSS_PCT']          ?? 20),   // sell if down X%
  maxOpenPositions:     Number(process.env['MAX_OPEN_POSITIONS']     ?? 3),    // max simultaneous holdings
  maxDailyLossUsdt:     Number(process.env['MAX_DAILY_LOSS_USDT']    ?? 100),  // pause if lost $X today
  maxHoldHours:         Number(process.env['MAX_HOLD_HOURS']         ?? 72),   // force-sell after X hours
  maxPriceImpactPct:    Number(process.env['MAX_PRICE_IMPACT_PCT']   ?? 3),    // reject if Jupiter impact > X%
  minUsdtReserve:       Number(process.env['MIN_USDT_RESERVE']       ?? 20),   // always keep $X USDT untouched
};
