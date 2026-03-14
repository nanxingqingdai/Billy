/**
 * 剔除市值 < $4000 的代币，并加入黑名单
 * 用法: npx ts-node scripts/filter-low-mc.ts
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const WATCHLIST_FILE = path.join(__dirname, '../data/watchlist.json');
const BLACKLIST_FILE = path.join(__dirname, '../data/watchlist-blacklist.json');
const MC_THRESHOLD = 4000;
const BATCH_SIZE = 30;

interface Token {
  mint: string;
  symbol: string;
  name: string;
  [key: string]: any;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function fetchMarketCaps(mints: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const batch = mints.slice(i, i + BATCH_SIZE);
    const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`;
    try {
      const resp = await axios.get(url, { timeout: 15000 });
      const pairs: any[] = resp.data;
      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const mc = pair.marketCap ?? pair.fdv ?? 0;
        // keep max MC across multiple pairs for the same token
        if (!result.has(mint) || mc > result.get(mint)!) {
          result.set(mint, mc);
        }
      }
    } catch (err: any) {
      console.error(`DexScreener batch failed: ${err.message}`);
    }
    if (i + BATCH_SIZE < mints.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return result;
}

async function main() {
  const watchlist: Token[] = readJson(WATCHLIST_FILE, []);
  const blacklist: string[] = readJson(BLACKLIST_FILE, []);

  const mints = watchlist.map(t => t.mint);
  console.log(`Fetching market caps for ${mints.length} tokens...`);

  const mcMap = await fetchMarketCaps(mints);

  const toRemove: Token[] = [];
  const toKeep: Token[] = [];

  for (const token of watchlist) {
    const mc = mcMap.get(token.mint) ?? 0;
    if (mc < MC_THRESHOLD) {
      toRemove.push(token);
      console.log(`  REMOVE ${token.symbol.padEnd(15)} MC=$${mc.toFixed(0)}`);
    } else {
      toKeep.push(token);
      console.log(`  KEEP   ${token.symbol.padEnd(15)} MC=$${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    }
  }

  if (toRemove.length === 0) {
    console.log('\nNo tokens below threshold. Watchlist unchanged.');
    return;
  }

  // Update watchlist
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(toKeep, null, 2));

  // Update blacklist
  const newBlacklist = Array.from(new Set([...blacklist, ...toRemove.map(t => t.mint)]));
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(newBlacklist, null, 2));

  console.log(`\n✅ Removed ${toRemove.length} tokens (added to blacklist):`);
  for (const t of toRemove) {
    const mc = mcMap.get(t.mint) ?? 0;
    console.log(`   - ${t.symbol} (${t.name})  MC=$${mc.toFixed(0)}`);
  }
  console.log(`Watchlist now has ${toKeep.length} tokens.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
