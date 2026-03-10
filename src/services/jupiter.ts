import axios from 'axios';
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config } from '../config/env';
import { keypairFromBase58 } from '../utils/keypair';
import { log } from '../utils/logger';

const QUOTE_API = 'https://quote-api.jup.ag/v6';

// ─── Common mint addresses ─────────────────────────────────────────────────

export const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// USDT has 6 decimals on Solana
export const USDT_DECIMALS = 6;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;       // smallest unit: lamports for SOL, raw units for SPL
  slippageBps?: number; // 50 = 0.5%  |  100 = 1%  |  300 = 3%
}

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  swapMode: string;
  routePlan: {
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }[];
}

export interface SwapResult {
  txid: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  explorerUrl: string;
}

// ─── Core API calls ────────────────────────────────────────────────────────

// ─── Retry helper ──────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = axios.isAxiosError(err) ? err.code : undefined;
      if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        const wait = delayMs * Math.pow(2, i); // exponential: 2s, 4s, 8s, 16s, 32s
        log('WARN', `Jupiter network error (${code}), retry ${i + 1}/${retries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Core API calls ────────────────────────────────────────────────────────

/**
 * Get the best swap route from Jupiter v6.
 */
export async function getQuote(params: QuoteParams): Promise<QuoteResponse> {
  return withRetry(() =>
    axios.get<QuoteResponse>(`${QUOTE_API}/quote`, {
      params: {
        inputMint:   params.inputMint,
        outputMint:  params.outputMint,
        amount:      params.amount,
        slippageBps: params.slippageBps ?? 100,
      },
      timeout: 10_000,
    }).then((r) => r.data)
  );
}

/**
 * Execute a swap: request the transaction from Jupiter, sign it, submit to chain.
 *
 * @param quote       QuoteResponse returned by getQuote()
 * @param dryRun      If true, skip sending — just log what would happen
 */
export async function executeSwap(
  quote: QuoteResponse,
  dryRun = false
): Promise<SwapResult> {
  const wallet     = keypairFromBase58(config.walletPrivateKey);
  const connection = new Connection(config.rpcUrl, 'confirmed');

  log('INFO', `Swap  IN : ${quote.inAmount} (${quote.inputMint})`);
  log('INFO', `Swap OUT : ${quote.outAmount} (${quote.outputMint})`);
  log('INFO', `Impact   : ${Number(quote.priceImpactPct).toFixed(4)}%`);

  if (dryRun) {
    log('WARN', '[DRY RUN] Transaction not sent.');
    return {
      txid: 'dry-run',
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      explorerUrl: '',
    };
  }

  // 1. Get serialised transaction from Jupiter
  const swapRes = await withRetry(() =>
    axios.post<{ swapTransaction: string }>(
      `${QUOTE_API}/swap`,
      {
        quoteResponse:             quote,
        userPublicKey:             wallet.publicKey.toBase58(),
        wrapAndUnwrapSol:          true,
        dynamicComputeUnitLimit:   true,
        prioritizationFeeLamports: 'auto',
      },
      { timeout: 15_000 }
    ).then((r) => r.data)
  );

  // 2. Deserialize → sign → send
  const txBuf      = Buffer.from(swapRes.swapTransaction, 'base64');
  const tx         = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries:    3,
  });
  log('INFO', `TX sent  : ${txid}`);

  // 3. Confirm
  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation    = await connection.confirmTransaction(
    { signature: txid, ...latestBlockhash },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  const explorerUrl = `https://solscan.io/tx/${txid}`;
  log('INFO', `Confirmed: ${explorerUrl}`);

  return {
    txid,
    inputMint:  quote.inputMint,
    outputMint: quote.outputMint,
    inAmount:   quote.inAmount,
    outAmount:  quote.outAmount,
    explorerUrl,
  };
}

// ─── Balance helpers ───────────────────────────────────────────────────────

/** Get native SOL balance of the wallet (in SOL, not lamports). */
export async function getSolBalance(): Promise<number> {
  const wallet     = keypairFromBase58(config.walletPrivateKey);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const lamports   = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/** Get SPL token balance (ui amount, accounting for decimals). Returns 0 if no account. */
export async function getTokenBalance(mintAddress: string): Promise<number> {
  const wallet     = keypairFromBase58(config.walletPrivateKey);
  const connection = new Connection(config.rpcUrl, 'confirmed');

  const accounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(mintAddress) }
  );
  if (accounts.value.length === 0) return 0;

  const info = accounts.value[0]!.account.data.parsed.info as {
    tokenAmount: { uiAmount: number | null };
  };
  return info.tokenAmount.uiAmount ?? 0;
}

// ─── Convenience wrappers ──────────────────────────────────────────────────

/**
 * Buy a token with SOL.
 *
 * @param outputMint   Token mint to buy
 * @param solAmount    Amount of SOL to spend
 * @param slippageBps  Slippage tolerance in bps (default 100 = 1%)
 * @param dryRun       If true, simulate only
 */
export async function buyWithSol(
  outputMint: string,
  solAmount: number,
  slippageBps = 100,
  dryRun = false
): Promise<SwapResult> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  log('INFO', `Buy  : ${solAmount} SOL → ${outputMint} (slippage ${slippageBps / 100}%)`);
  const quote = await getQuote({ inputMint: SOL_MINT, outputMint, amount: lamports, slippageBps });
  return executeSwap(quote, dryRun);
}

/**
 * Sell a token back to SOL.
 *
 * @param inputMint    Token mint to sell
 * @param tokenAmount  Raw token amount (smallest unit). Use getTokenBalance() + decimals.
 * @param slippageBps  Slippage tolerance in bps (default 100 = 1%)
 * @param dryRun       If true, simulate only
 */
export async function sellToSol(
  inputMint: string,
  tokenAmount: number,
  slippageBps = 100,
  dryRun = false
): Promise<SwapResult> {
  log('INFO', `Sell : ${tokenAmount} raw units of ${inputMint} → SOL (slippage ${slippageBps / 100}%)`);
  const quote = await getQuote({ inputMint, outputMint: SOL_MINT, amount: tokenAmount, slippageBps });
  return executeSwap(quote, dryRun);
}

/**
 * Buy a token with USDT.
 *
 * @param outputMint   Token mint to buy
 * @param usdtAmount   Amount of USDT to spend (human-readable, e.g. 50 = $50)
 * @param slippageBps  Slippage tolerance in bps (default 100 = 1%)
 * @param dryRun       If true, simulate only
 */
export async function buyWithUsdt(
  outputMint: string,
  usdtAmount: number,
  slippageBps = 100,
  dryRun = false
): Promise<SwapResult> {
  const rawAmount = toRawAmount(usdtAmount, USDT_DECIMALS);
  log('INFO', `Buy  : ${usdtAmount} USDT → ${outputMint} (slippage ${slippageBps / 100}%)`);
  const quote = await getQuote({ inputMint: USDT_MINT, outputMint, amount: rawAmount, slippageBps });
  return executeSwap(quote, dryRun);
}

/**
 * Sell a token back to USDT.
 *
 * @param inputMint    Token mint to sell
 * @param tokenAmount  Raw token amount (smallest unit). Use toRawAmount(uiAmount, decimals).
 * @param slippageBps  Slippage tolerance in bps (default 100 = 1%)
 * @param dryRun       If true, simulate only
 */
export async function sellToUsdt(
  inputMint: string,
  tokenAmount: number,
  slippageBps = 100,
  dryRun = false
): Promise<SwapResult> {
  log('INFO', `Sell : ${tokenAmount} raw units of ${inputMint} → USDT (slippage ${slippageBps / 100}%)`);
  const quote = await getQuote({ inputMint, outputMint: USDT_MINT, amount: tokenAmount, slippageBps });
  return executeSwap(quote, dryRun);
}

// ─── Unit helpers ──────────────────────────────────────────────────────────

/** Convert a USD value to lamports given the current SOL price. */
export function usdToLamports(usdAmount: number, solPriceUsd: number): number {
  return Math.floor((usdAmount / solPriceUsd) * LAMPORTS_PER_SOL);
}

/** Convert lamports to USD given the current SOL price. */
export function lamportsToUsd(lamports: number, solPriceUsd: number): number {
  return (lamports / LAMPORTS_PER_SOL) * solPriceUsd;
}

/** Convert token UI amount to raw integer units. */
export function toRawAmount(uiAmount: number, decimals: number): number {
  return Math.floor(uiAmount * Math.pow(10, decimals));
}

/** Convert USDT human amount to raw units (6 decimals). */
export function usdtToRaw(usdtAmount: number): number {
  return toRawAmount(usdtAmount, USDT_DECIMALS);
}

/** Convert raw USDT units back to human-readable amount. */
export function rawToUsdt(rawAmount: number): number {
  return rawAmount / Math.pow(10, USDT_DECIMALS);
}
