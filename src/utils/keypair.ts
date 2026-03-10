import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Decode a Base58 private key string into a Solana Keypair.
 */
export function keypairFromBase58(base58PrivateKey: string): Keypair {
  const secretKey = bs58.decode(base58PrivateKey);
  return Keypair.fromSecretKey(secretKey);
}
