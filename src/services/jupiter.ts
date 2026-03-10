import axios from 'axios';

const BASE_URL = 'https://quote-api.jup.ag/v6';

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;       // in lamports / smallest unit
  slippageBps?: number; // e.g. 50 = 0.5%
}

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

/**
 * Get a swap quote from Jupiter Aggregator v6.
 */
export async function getQuote(params: QuoteParams): Promise<QuoteResponse> {
  const res = await axios.get<QuoteResponse>(`${BASE_URL}/quote`, {
    params: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: params.slippageBps ?? 50,
    },
  });
  return res.data;
}
