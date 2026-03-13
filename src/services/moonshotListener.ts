/**
 * Moonshot TG 频道监听器
 *
 * 同时监控两个公开频道，取并集，过滤 RWA/股票代币，
 * 自动跑前置条件检查，通过则加入 watchlist。
 *
 * 频道：
 *   https://t.me/s/moonshotlistings  （主列表）
 *   https://t.me/s/moonshotnews      （新闻/备份）
 *
 * 使用方式：
 *   直接 import 并调用 startMoonshotListener()
 *   或单独运行：npx ts-node scripts/runMoonshotListener.ts
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { checkEntryPreConditions, getTokenOverview } from './birdeye';
import { addToken, getWatchlist } from '../config/watchlist';
import { log } from '../utils/logger';
import { notifyNewToken } from './telegramNotifier';

// ─── 配置 ──────────────────────────────────────────────────────────────────

const TG_CHANNELS = [
  'https://t.me/s/moonshotlistings',
  'https://t.me/s/moonshotnews',
];

/** 轮询间隔（毫秒），默认 5 分钟 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** 已见过的 CA 持久化文件，防止重复处理 */
const SEEN_FILE = path.resolve(process.cwd(), 'data', 'moonshot-seen.json');

/** 新代币加入 watchlist 时的默认参数 */
const DEFAULT_TOKEN_PARAMS = {
  active:       true,
  maxBuyUsdt:   30,
  slippageBps:  300,
  signal: {
    interval:               '1H' as const,
    lookback:               10,
    minLowAmpBars:          3,
    maxAmplitudePct:        4,
    volumeContractionRatio: 0.65,
  },
  sellBatches: [
    { priceMultiplier: 1.5, portion: 0.34 },
    { priceMultiplier: 2.0, portion: 0.33 },
    { priceMultiplier: 3.0, portion: 0.33 },
  ],
};

// ─── RWA / 股票代币过滤 ─────────────────────────────────────────────────────

/**
 * 常见股票代码 & RWA 关键词。
 * 匹配代币 symbol（大写）或 name（小写）含以下内容则剔除。
 */
const STOCK_SYMBOLS = new Set([
  // 美股蓝筹
  'AAPL','TSLA','NVDA','MSFT','GOOGL','GOOG','AMZN','META','NFLX',
  'AMD','INTC','ORCL','CRM','ADBE','QCOM','AVGO','TXN','MU',
  'JPM','BAC','GS','MS','WFC','C','BRK','V','MA','PYPL',
  'DIS','COIN','HOOD','RBLX','SNAP','UBER','LYFT','SPOT','ABNB',
  'SHOP','SQ','TWLO','ZM','DOCU','PLTR','AFRM','DKNG','PENN',
  'GME','AMC','BBY','WMT','TGT','COST','HD','LOW',
  'SPY','QQQ','IWM','DIA','GLD','SLV','USO','TLT',
  // 港股/A股常见
  'BABA','JD','PDD','BIDU','NIO','XPEV','LI','TCEHY',
  // RWA 项目名
  'RWA','ONDO','POLYX','CFG','MPL','TRU','GFI',
]);

const RWA_NAME_KEYWORDS = [
  'stock', 'rwa', 'equity', 'share', 'tokenized', 'real world asset',
  'treasury', 'fund', 'etf', 'bond', 'dividend', 'inc.', 'corp.',
  'corporation', 'holdings', 'nasdaq', 'nyse',
];

/**
 * 判断代币是否为 RWA / 股票代币。
 * symbol 传大写，name 传原始。
 */
function isRwaToken(symbol: string, name: string): boolean {
  const symUpper  = symbol.toUpperCase();
  const nameLower = name.toLowerCase();

  if (STOCK_SYMBOLS.has(symUpper)) return true;
  if (RWA_NAME_KEYWORDS.some((kw) => nameLower.includes(kw))) return true;

  return false;
}

// ─── Solana 地址识别 ────────────────────────────────────────────────────────

// Base58 字符集（无 0/O/I/l），长度 32–44
const SOLANA_ADDR_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

/** 过滤掉明显不是代币 mint 的地址（已知系统程序等） */
const SYSTEM_ADDRS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

function extractSolanaAddresses(html: string): string[] {
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  SOLANA_ADDR_RE.lastIndex = 0;
  while ((m = SOLANA_ADDR_RE.exec(html)) !== null) {
    const addr = m[1];
    if (!SYSTEM_ADDRS.has(addr)) {
      matches.add(addr);
    }
  }
  return [...matches];
}

// ─── 持久化已处理的 CA ──────────────────────────────────────────────────────

function loadSeen(): Set<string> {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) as string[]);
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveSeen(seen: Set<string>): void {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
  } catch (e) {
    log('WARN', `[Moonshot] Failed to persist seen list: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── 核心：抓两个频道并取并集 ───────────────────────────────────────────────

async function fetchChannel(url: string): Promise<string[]> {
  const resp = await axios.get<string>(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
    timeout: 15_000,
    responseType: 'text',
  });
  return extractSolanaAddresses(resp.data);
}

async function fetchNewAddresses(seen: Set<string>): Promise<string[]> {
  const watchlistMints = new Set(getWatchlist().map((t) => t.mint));

  // 并发抓两个频道
  const results = await Promise.allSettled(
    TG_CHANNELS.map((url) => fetchChannel(url)),
  );

  const union = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      r.value.forEach((addr) => union.add(addr));
      log('INFO', `[Moonshot] 频道 ${i + 1} 获取 ${r.value.length} 个地址`);
    } else {
      log('WARN', `[Moonshot] 频道 ${i + 1} 抓取失败: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }

  // 过滤已见过 / 已在 watchlist
  return [...union].filter((addr) => !seen.has(addr) && !watchlistMints.has(addr));
}

// ─── 单次轮询 ───────────────────────────────────────────────────────────────

async function poll(seen: Set<string>): Promise<void> {
  log('INFO', '[Moonshot] 开始轮询两个频道...');

  let newAddrs: string[];
  try {
    newAddrs = await fetchNewAddresses(seen);
  } catch (err) {
    log('WARN', `[Moonshot] 抓取失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (newAddrs.length === 0) {
    log('INFO', '[Moonshot] 无新 CA');
    return;
  }

  log('INFO', `[Moonshot] 并集去重后 ${newAddrs.length} 个新 CA，逐一检查...`);

  for (const mint of newAddrs) {
    seen.add(mint);

    try {
      // ── Step 1: 拉 overview，先做 RWA 过滤 ──────────────────────────────
      let symbol = mint.slice(0, 6) + '...';
      let name   = 'Unknown';
      try {
        const overview = await getTokenOverview(mint);
        symbol = overview.symbol || symbol;
        name   = overview.name   || name;
      } catch {
        // Birdeye 400 → 无效地址，跳过
        log('INFO', `[Moonshot] ⚠️  ${mint} Birdeye 无数据，跳过`);
        continue;
      }

      if (isRwaToken(symbol, name)) {
        log('INFO', `[Moonshot] 🚫 ${symbol} (${mint}) 识别为 RWA/股票代币，已剔除`);
        continue;
      }

      // ── Step 2: 前置条件检查 ─────────────────────────────────────────────
      log('INFO', `[Moonshot] 检查 ${symbol} (${mint})`);
      const pre = await checkEntryPreConditions(mint);

      if (!pre.passed) {
        log('INFO', `[Moonshot] ❌ ${symbol} 前置条件不通过: ${pre.reason}`);
        continue;
      }

      // ── Step 3: 加入 watchlist ───────────────────────────────────────────
      const errors = addToken({ symbol, name, mint, ...DEFAULT_TOKEN_PARAMS });

      if (errors.length > 0) {
        log('WARN', `[Moonshot] addToken 失败 (${mint}): ${errors.join(', ')}`);
      } else {
        log('INFO', `[Moonshot] ✅ ${symbol} (${mint}) 通过前置条件，已加入 watchlist！`);
        log('INFO', `[Moonshot]    drawdown=${pre.drawdownPct.toFixed(1)}% | age=${Math.floor(pre.ageDays)}d | ampBars=${pre.lowAmpBars} | volBars=${pre.lowVolBars}`);
        await notifyNewToken(symbol, mint, pre.drawdownPct, pre.ageDays);
      }

      await new Promise((r) => setTimeout(r, 2_000));

    } catch (err) {
      log('WARN', `[Moonshot] 检查 ${mint} 出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  saveSeen(seen);
}

// ─── 对外接口 ───────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动 Moonshot 频道监听器。
 * 立即执行一次，之后每隔 POLL_INTERVAL_MS 重复。
 */
export function startMoonshotListener(): void {
  if (_timer) {
    log('WARN', '[Moonshot] 监听器已在运行');
    return;
  }

  const seen = loadSeen();
  log('INFO', `[Moonshot] 监听器启动 | 频道数: ${TG_CHANNELS.length} | 已知CA: ${seen.size} | 轮询间隔: ${POLL_INTERVAL_MS / 60_000}分钟`);

  poll(seen).catch((e) => log('WARN', `[Moonshot] poll error: ${e}`));

  _timer = setInterval(() => {
    poll(seen).catch((e) => log('WARN', `[Moonshot] poll error: ${e}`));
  }, POLL_INTERVAL_MS);
}

/** 停止监听器（清理 interval） */
export function stopMoonshotListener(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    log('INFO', '[Moonshot] 监听器已停止');
  }
}
