/**
 * pumpfun-1m-scan.ts
 *
 * 扫描过去 30 天内 pump.fun 发射的 Solana memecoin，
 * 找出自发射以来累计交易量超过 100 万美元的代币，输出到桌面 Excel。
 *
 * 数据源:
 *  - Dune API (query 6827349): 主数据，< 30 秒
 *  - DexScreener: 补充社交链接、当前市值、24h 成交量
 *
 * 运行: npx ts-node scripts/pumpfun-1m-scan.ts
 */

import axios from 'axios';
import * as XLSX from 'xlsx';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config();

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DUNE_API_KEY = process.env.DUNE_API_KEY;
if (!DUNE_API_KEY) { console.error('❌ .env 缺少 DUNE_API_KEY'); process.exit(1); }

const QUERY_ID = 6827349;
const LIMIT    = 1000;
const DESKTOP  = path.join(os.homedir(), 'Desktop');
const OUT_FILE = path.join(DESKTOP, `pumpfun_1m_volume_${yyyymmdd()}.xlsx`);

function yyyymmdd() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function fmtMoney(n: number) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

// ─── CSV 解析（支持字段内含逗号的引号格式）────────────────────────────────────

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
        if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
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

// ─── DexScreener ─────────────────────────────────────────────────────────────

const ds = axios.create({ baseURL: 'https://api.dexscreener.com', timeout: 15_000 });

interface DsInfo {
  name:           string;
  symbol:         string;
  vol24h:         number;
  liquidity:      number;
  mcap:           number;
  priceUsd:       number;
  priceChange24h: number;
  twitter:        string;
  telegram:       string;
  website:        string;
}

async function getDsInfo(mint: string): Promise<DsInfo | null> {
  try {
    const res  = await ds.get<any>(`/latest/dex/tokens/${mint}`);
    const pairs: any[] = res.data?.pairs ?? [];
    if (!pairs.length) return null;
    const best = [...pairs].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0]!;
    const info = best.info ?? {};
    return {
      name:           best.baseToken?.name ?? '',
      symbol:         best.baseToken?.symbol ?? '',
      vol24h:         Number(best.volume?.h24 ?? 0),
      liquidity:      Number(best.liquidity?.usd ?? 0),
      mcap:           Number(best.marketCap ?? best.fdv ?? 0),
      priceUsd:       Number(best.priceUsd ?? 0),
      priceChange24h: Number(best.priceChange?.h24 ?? 0),
      twitter:  info.socials?.find((s: any) => s.type === 'twitter')?.url ?? '',
      telegram: info.socials?.find((s: any) => s.type === 'telegram')?.url ?? '',
      website:  info.websites?.[0]?.url ?? '',
    };
  } catch { return null; }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(64));
  console.log('🚀 PumpFun 1M 扫描器 (Dune API + DexScreener)');
  console.log(`   Query ID  : ${QUERY_ID}`);
  console.log(`   输出路径  : ${OUT_FILE}`);
  console.log('='.repeat(64));

  // ── Step 1: 从 Dune 拉取数据 ──────────────────────────────────────────────
  console.log('\n📡 Step 1: 从 Dune 拉取查询结果...');
  let duneRows: Record<string, string>[];
  try {
    const res = await axios.get<string>(
      `https://api.dune.com/api/v1/query/${QUERY_ID}/results/csv`,
      {
        params:       { limit: LIMIT },
        headers:      { 'x-dune-api-key': DUNE_API_KEY },
        timeout:      60_000,
        responseType: 'text',
      }
    );
    duneRows = parseCsv(res.data);
  } catch (err: any) {
    console.error(`❌ Dune 请求失败 (HTTP ${err.response?.status}):`, err.response?.data ?? err.message);
    process.exit(1);
  }

  console.log(`✅ Dune 返回 ${duneRows.length} 条数据`);
  if (!duneRows.length) { console.log('⚠️  无数据'); return; }

  // 打印字段名帮助调试
  console.log('📋 Dune 字段:', Object.keys(duneRows[0]!).join(' | '));

  // 自动识别 mint / volume / symbol 字段
  const keys     = Object.keys(duneRows[0]!);
  const mintField = keys.find(k => /mint|token_address|contract_address|address/i.test(k));
  const volField  = keys.find(k => /volume|vol|usd/i.test(k));
  const symField  = keys.find(k => /symbol|ticker/i.test(k));
  const nameField = keys.find(k => /^name$|token_name/i.test(k));

  if (!mintField) {
    console.error('❌ 无法识别 mint 地址字段，请检查 Dune 查询输出列名');
    process.exit(1);
  }
  console.log(`   mint字段=${mintField}  vol字段=${volField ?? '未找到'}  sym字段=${symField ?? '未找到'}`);

  // ── Step 2: 用 DexScreener 补充信息 ──────────────────────────────────────
  console.log(`\n🔍 Step 2: DexScreener 补充数据 (共 ${duneRows.length} 个代币)...`);

  interface EnrichedRow {
    dune:   Record<string, string>;
    ds:     DsInfo | null;
    mint:   string;
  }

  const enriched: EnrichedRow[] = [];
  let done = 0;

  for (const row of duneRows) {
    done++;
    const mint = row[mintField] ?? '';
    process.stdout.write(`\r  [${done}/${duneRows.length}] ${mint.slice(0,8)}...`);

    const ds = mint ? await getDsInfo(mint) : null;
    enriched.push({ dune: row, ds, mint });

    // DexScreener 公共 API 限速约 300 req/min，间隔 250ms 即可
    await sleep(250);
  }
  console.log('\n✅ 补充完成');

  // ── Step 3: 写 Excel ───────────────────────────────────────────────────────
  const excelRows = enriched
    .sort((a, b) => {
      if (!volField) return 0;
      return Number(b.dune[volField] ?? 0) - Number(a.dune[volField] ?? 0);
    })
    .map(({ dune, ds, mint }) => {
      const sym  = ds?.symbol  || (symField  ? dune[symField]  : '') || '';
      const name = ds?.name    || (nameField ? dune[nameField] : '') || '';

      // Dune 原始字段（数字自动转 number）
      const duneOut: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(dune)) {
        const n = Number(v);
        duneOut[k] = (!isNaN(n) && v !== '') ? n : v;
      }

      return {
        ...duneOut,
        '代币名称':        name,
        '符号':            sym,
        '当前市值(USD)':   ds?.mcap           ?? 0,
        '当前价格(USD)':   ds?.priceUsd       ?? 0,
        '24h成交量(USD)':  ds?.vol24h         ?? 0,
        '当前流动性(USD)': ds?.liquidity      ?? 0,
        '24h价格变化%':    ds ? `${ds.priceChange24h.toFixed(2)}%` : '',
        'Twitter':         ds?.twitter        ?? '',
        'Telegram':        ds?.telegram       ?? '',
        'Website':         ds?.website        ?? '',
        'DexScreener':     mint ? `https://dexscreener.com/solana/${mint}` : '',
        'BirdEye':         mint ? `https://birdeye.so/token/${mint}?chain=solana` : '',
        'PumpFun':         mint ? `https://pump.fun/${mint}` : '',
      };
    });

  const ws = XLSX.utils.json_to_sheet(excelRows);
  const colKeys = Object.keys(excelRows[0] ?? {});
  ws['!cols'] = colKeys.map(k => ({ wch: Math.min(55, Math.max(12, k.length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PumpFun_1M_Volume');
  XLSX.writeFile(wb, OUT_FILE);

  // ── Step 4: 终端摘要 ───────────────────────────────────────────────────────
  const top = enriched
    .filter(r => volField ? Number(r.dune[volField]) > 0 : true)
    .sort((a, b) => volField
      ? Number(b.dune[volField!] ?? 0) - Number(a.dune[volField!] ?? 0)
      : 0
    )
    .slice(0, 15);

  console.log(`\n📊 Top ${top.length} 代币:`);
  console.log('  ' + '─'.repeat(72));
  for (const { dune, ds } of top) {
    const sym = (ds?.symbol || (symField ? dune[symField!] : '?') || '?').padEnd(16);
    const vol = volField ? fmtMoney(Number(dune[volField])).padEnd(14) : ''.padEnd(14);
    const mc  = fmtMoney(ds?.mcap ?? 0).padEnd(12);
    console.log(`  ${sym} 累计量=${vol} 市值=${mc}`);
  }

  console.log(`\n✨ Excel 已生成: ${OUT_FILE}`);
  console.log(`   共 ${excelRows.length} 个代币`);
}

main().catch(err => {
  console.error('\n❌ 出错:', err.message ?? err);
  process.exit(1);
});
