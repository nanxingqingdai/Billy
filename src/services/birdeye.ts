import axios from 'axios';
import { config } from '../config/env';

const BASE_URL = 'https://public-api.birdeye.so';

export interface TokenPrice {
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
}

/**
 * Fetch the current price of a token by its mint address.
 */
export async function getTokenPrice(mintAddress: string): Promise<TokenPrice> {
  const res = await axios.get<{ data: TokenPrice }>(`${BASE_URL}/defi/price`, {
    params: { address: mintAddress },
    headers: {
      'X-API-KEY': config.birdeyeApiKey,
      'x-chain': 'solana',
    },
  });
  return res.data.data;
}
