/**
 * dune-pumpfun-scan.ts
 *
 * 通过 Dune API 拉取 pump.fun 高交易量代币（query 6827349），
 * 输出到桌面 Excel。运行时间 < 30 秒。
 *
 * 运行: npx ts-node scripts/dune-pumpfun-scan.ts
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

const QUERY_ID  = 6827349;
const LIMIT     = 1000;
const DESKTOP   = path.join(os.homedir(), 'Desktop');
const OUT_FILE  = path.join(DESKTOP, `dune_pumpfun_1m_${yyyymmdd()}.xlsx`);

function yyyymmdd() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function fmtMoney(n: number) {
  if (!n || isNaN(n)) return '';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

// ─── 解析 CSV（手动解析，支持字段内含逗号的引号包裹格式）────────────────────

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

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('🚀 Dune PumpFun 1M 扫描器');
  console.log(`   Query ID : ${QUERY_ID}`);
  console.log(`   输出路径 : ${OUT_FILE}`);
  console.log('='.repeat(60));

  // ── 拉取 CSV ─────────────────────────────────────────────────────────────
  console.log('\n📡 正在从 Dune 拉取数据...');
  let csvText: string;
  try {
    const res = await axios.get<string>(
      `https://api.dune.com/api/v1/query/${QUERY_ID}/results/csv`,
      {
        params: { limit: LIMIT },
        headers: { 'x-dune-api-key': DUNE_API_KEY },
        timeout: 60_000,
        responseType: 'text',
      }
    );
    csvText = res.data;
  } catch (err: any) {
    const status = err.response?.status;
    const msg    = err.response?.data ?? err.message;
    console.error(`❌ Dune API 请求失败 (HTTP ${status}):`, msg);
    process.exit(1);
  }

  const rows = parseCsv(csvText);
  console.log(`✅ 获取到 ${rows.length} 条数据`);

  if (rows.length === 0) {
    console.log('⚠️  无数据返回，请检查 Query ID 或 API Key');
    return;
  }

  // ── 打印列名（方便调试）────────────────────────────────────────────────
  console.log('\n📋 字段列表:', Object.keys(rows[0]!).join(' | '));

  // ── 写 Excel ─────────────────────────────────────────────────────────────
  // 原样保留所有列，另加 DexScreener / BirdEye 链接列（如有 mint 地址字段）
  const mintField = Object.keys(rows[0]!).find(k =>
    /mint|token_address|address|contract/i.test(k)
  );

  const excelRows = rows.map(r => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(r)) {
      // 数字字段转为 number 类型
      const num = Number(v);
      out[k] = (!isNaN(num) && v !== '') ? num : v;
    }
    if (mintField && r[mintField]) {
      const mint = r[mintField]!;
      out['DexScreener'] = `https://dexscreener.com/solana/${mint}`;
      out['BirdEye']     = `https://birdeye.so/token/${mint}?chain=solana`;
      out['PumpFun']     = `https://pump.fun/${mint}`;
    }
    return out;
  });

  const ws = XLSX.utils.json_to_sheet(excelRows);
  // 自动列宽（最大 50）
  const colKeys = Object.keys(excelRows[0] ?? {});
  ws['!cols'] = colKeys.map(k => ({ wch: Math.min(50, Math.max(12, k.length + 4)) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PumpFun_Dune');
  XLSX.writeFile(wb, OUT_FILE);

  // ── 终端摘要 ──────────────────────────────────────────────────────────────
  // 尝试找交易量字段打印 Top 15
  const volField = Object.keys(rows[0]!).find(k =>
    /volume|vol|usd_volume|total_vol/i.test(k)
  );
  const symField = Object.keys(rows[0]!).find(k =>
    /symbol|sym|name|token_name/i.test(k)
  );

  if (volField) {
    const sorted = [...rows].sort((a, b) =>
      Number(b[volField] ?? 0) - Number(a[volField] ?? 0)
    );
    const top = sorted.slice(0, 15);
    console.log(`\n📊 Top ${top.length} (按 ${volField}):`);
    console.log('  ' + '─'.repeat(70));
    for (const r of top) {
      const sym = symField ? (r[symField] ?? '?').padEnd(16) : '?'.padEnd(16);
      const vol = fmtMoney(Number(r[volField])).padEnd(14);
      const mint = (mintField ? r[mintField] ?? '' : '').slice(0, 8) + '...';
      console.log(`  ${sym} ${volField}=${vol} mint=${mint}`);
    }
  }

  console.log(`\n✨ Excel 已生成: ${OUT_FILE}`);
}

main().catch(err => {
  console.error('\n❌ 出错:', err.message ?? err);
  process.exit(1);
});
