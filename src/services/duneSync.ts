/**
 * duneSync.ts
 *
 * 每 25 分钟从 Dune query 6827349 拉取一次 pump.fun 高交易量代币列表，
 * 去重 + 黑名单过滤后自动加入 watchlist。
 *
 * 规则：
 *  - 已在 watchlist 的代币：跳过
 *  - 用户手动删除过的代币（黑名单）：永不自动添加
 *  - 用户手动添加某黑名单代币：从黑名单移除（由 addToken 处理）
 */

import axios from 'axios';
import { addTokenAuto } from '../config/watchlist';
import { log } from '../utils/logger';

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DUNE_QUERY_ID    = 6827349;
const DUNE_LIMIT       = 1000;
const SYNC_INTERVAL_MS = 25 * 60 * 1000;   // 25 分钟

/** 新代币自动加入 watchlist 时的默认参数 */
const DEFAULT_PARAMS = {
  active:      true,
  maxBuyUsdt:  30,
  slippageBps: 300,
  signal: {
    interval:               '1H' as const,
    lookback:               10,
    minLowAmpBars:          3,
    maxAmplitudePct:        4,
    volumeContractionRatio: 0.5,
    maxVolPeakRatio:        0.1,
  },
  sellBatches: [
    { priceMultiplier: 1.5, portion: 0.34 },
    { priceMultiplier: 2.0, portion: 0.33 },
    { priceMultiplier: 3.0, portion: 0.33 },
  ],
};

// ─── CSV 解析 ─────────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  };

  const headers = parseRow(lines[0]!);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(l => {
      const vals = parseRow(l);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
      return row;
    });
}

// ─── 单次同步 ─────────────────────────────────────────────────────────────────

async function syncOnce(): Promise<void> {
  const apiKey = process.env['DUNE_API_KEY'];
  if (!apiKey) {
    log('WARN', '[DuneSync] DUNE_API_KEY not set — skipping sync');
    return;
  }

  log('INFO', `[DuneSync] 开始拉取 Dune query ${DUNE_QUERY_ID}...`);

  let rows: Record<string, string>[];
  try {
    const res = await axios.get<string>(
      `https://api.dune.com/api/v1/query/${DUNE_QUERY_ID}/results/csv`,
      {
        params:       { limit: DUNE_LIMIT },
        headers:      { 'x-dune-api-key': apiKey },
        timeout:      60_000,
        responseType: 'text',
      }
    );
    rows = parseCsv(res.data);
  } catch (err: any) {
    log('WARN', `[DuneSync] 拉取失败: ${err.message}`);
    return;
  }

  if (!rows.length) {
    log('WARN', '[DuneSync] Dune 返回空数据，跳过本次同步');
    return;
  }

  // 自动识别字段名（兼容 Dune 查询列名变化）
  const keys      = Object.keys(rows[0]!);
  const mintField = keys.find(k => /mint|token_address|contract_address|^address$/i.test(k));
  const symField  = keys.find(k => /symbol|ticker/i.test(k));
  const nameField = keys.find(k => /^name$|token_name/i.test(k));

  if (!mintField) {
    log('WARN', `[DuneSync] 无法识别 mint 字段，跳过。当前列: ${keys.join(', ')}`);
    return;
  }

  let added = 0, skipped = 0, blacklisted = 0;

  for (const row of rows) {
    const mint   = (row[mintField] ?? '').trim();
    const symbol = (symField  ? row[symField]  : '') || mint.slice(0, 6).toUpperCase();
    const name   = (nameField ? row[nameField] : '') || symbol;

    if (!mint) { skipped++; continue; }

    const result = addTokenAuto({ mint, symbol, name, ...DEFAULT_PARAMS });
    if      (result === 'added')       added++;
    else if (result === 'blacklisted') blacklisted++;
    else                               skipped++;
  }

  log('INFO',
    `[DuneSync] 完成 — 总计 ${rows.length} 条 | ` +
    `新增 ${added} | 已存在 ${skipped} | 黑名单跳过 ${blacklisted}`
  );
}

// ─── 启动定时器 ───────────────────────────────────────────────────────────────

export function startDuneSync(): void {
  log('INFO', `[DuneSync] 启动，间隔 ${SYNC_INTERVAL_MS / 60_000} 分钟`);

  // 立即执行一次
  syncOnce().catch(err => log('WARN', `[DuneSync] 初次同步出错: ${err.message}`));

  // 之后每 25 分钟执行
  setInterval(() => {
    syncOnce().catch(err => log('WARN', `[DuneSync] 定时同步出错: ${err.message}`));
  }, SYNC_INTERVAL_MS);
}
