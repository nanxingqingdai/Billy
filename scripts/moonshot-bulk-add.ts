/**
 * 从 moonshotlistings 频道批量添加代币到 watchlist
 * 跳过前置条件检查，仅过滤 RWA / 股票类代币
 * 用法: npx ts-node scripts/moonshot-bulk-add.ts
 */

import axios from 'axios';
import { addTokenAuto } from '../src/config/watchlist';
import { log } from '../src/utils/logger';

const CHANNEL_URL = 'https://t.me/s/moonshotlistings';

// ─── RWA / 股票过滤（与 moonshotListener.ts 保持一致）──────────────────────

const STOCK_SYMBOLS = new Set([
  'AAPL','TSLA','NVDA','MSFT','GOOGL','GOOG','AMZN','META','NFLX',
  'AMD','INTC','ORCL','CRM','ADBE','QCOM','AVGO','TXN','MU',
  'JPM','BAC','GS','MS','WFC','C','BRK','V','MA','PYPL',
  'DIS','COIN','HOOD','RBLX','SNAP','UBER','LYFT','SPOT','ABNB',
  'SHOP','SQ','TWLO','ZM','DOCU','PLTR','AFRM','DKNG','PENN',
  'GME','AMC','BBY','WMT','TGT','COST','HD','LOW',
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT',
  'BABA','JD','PDD','BIDU','NIO','XPEV','LI','TCEHY',
  'RWA','ONDO','POLYX','CFG','MPL','TRU','GFI',
]);

const RWA_NAME_KEYWORDS = [
  'stock','rwa','equity','share','tokenized','real world asset',
  'treasury','fund','etf','bond','dividend','inc.','corp.',
  'corporation','holdings','nasdaq','nyse',
  // xStock 系列
  'xstock','x stock',
];

// symbol 末尾带 x（如 AAPLx、TSLAx）也过滤
const XSTOCK_RE = /^[A-Z]{1,5}x$/;

function isRwa(symbol: string, name: string): boolean {
  const sym  = symbol.toUpperCase();
  const nm   = name.toLowerCase();
  if (STOCK_SYMBOLS.has(sym)) return true;
  if (XSTOCK_RE.test(sym)) return true;
  if (RWA_NAME_KEYWORDS.some(kw => nm.includes(kw))) return true;
  return false;
}

// ─── Solana 地址提取 ────────────────────────────────────────────────────────

const SOLANA_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
const SYSTEM_ADDRS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

function extractAddresses(html: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  SOLANA_RE.lastIndex = 0;
  while ((m = SOLANA_RE.exec(html)) !== null) {
    if (!SYSTEM_ADDRS.has(m[1])) seen.add(m[1]);
  }
  return [...seen];
}

// ─── 默认参数 ───────────────────────────────────────────────────────────────

const DEFAULT_PARAMS = {
  active: true,
  maxBuyUsdt: 30,
  slippageBps: 300,
  signal: {
    interval: '1H' as const,
    lookback: 10,
    minLowAmpBars: 3,
    maxAmplitudePct: 4,
    volumeContractionRatio: 0.5,
    maxVolPeakRatio: 0.1,
  },
  sellBatches: [
    { priceMultiplier: 1.5, portion: 0.34 },
    { priceMultiplier: 2.0, portion: 0.33 },
    { priceMultiplier: 3.0, portion: 0.33 },
  ],
};

// ─── DexScreener 获取 symbol / name ────────────────────────────────────────

async function getTokenInfo(mint: string): Promise<{ symbol: string; name: string } | null> {
  try {
    const res = await axios.get<{ pairs: any[] | null }>(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 10_000 },
    );
    const pairs = res.data.pairs ?? [];
    // 找流动性最高的 pair
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best?.baseToken) return null;
    return { symbol: best.baseToken.symbol ?? '', name: best.baseToken.name ?? '' };
  } catch {
    return null;
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  log('INFO', `[BulkAdd] 抓取频道: ${CHANNEL_URL}`);
  const resp = await axios.get<string>(CHANNEL_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
    timeout: 20_000,
    responseType: 'text',
  });

  const addresses = extractAddresses(resp.data);
  log('INFO', `[BulkAdd] 提取到 ${addresses.length} 个地址`);

  let added = 0, skippedRwa = 0, skippedExists = 0, skippedBlacklist = 0, skippedError = 0;

  for (const mint of addresses) {
    let symbol = mint.slice(0, 6) + '...';
    let name   = 'Unknown';

    const info = await getTokenInfo(mint);
    if (!info) {
      log('INFO', `[BulkAdd] ⚠️  ${mint} DexScreener 无数据，跳过`);
      skippedError++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    symbol = info.symbol || symbol;
    name   = info.name   || name;

    if (isRwa(symbol, name)) {
      log('INFO', `[BulkAdd] 🚫 ${symbol} — RWA/股票/xStock，跳过`);
      skippedRwa++;
      continue;
    }

    const result = addTokenAuto({ symbol, name, mint, ...DEFAULT_PARAMS });

    if (result === 'added') {
      log('INFO', `[BulkAdd] ✅ ${symbol} (${mint.slice(0,8)}…) 已加入 watchlist`);
      added++;
    } else if (result === 'exists') {
      log('INFO', `[BulkAdd] — ${symbol} 已在 watchlist`);
      skippedExists++;
    } else {
      log('INFO', `[BulkAdd] 🔒 ${symbol} 在黑名单中，跳过`);
      skippedBlacklist++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  log('INFO', '');
  log('INFO', `[BulkAdd] ✅ 完成！新增: ${added} | 已存在: ${skippedExists} | 黑名单: ${skippedBlacklist} | RWA过滤: ${skippedRwa} | 无数据: ${skippedError}`);
}

main().catch(err => {
  console.error('[BulkAdd] FATAL:', err);
  process.exit(1);
});
