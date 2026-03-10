import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  rpcUrl: process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  walletPrivateKey: process.env['WALLET_PRIVATE_KEY'] ?? '',
  birdeyeApiKey: process.env['BIRDEYE_API_KEY'] ?? '',
};
