import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

const DATA_DIR   = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'signal-history.json');

/** 单条信号记录 */
export interface SignalRecord {
  timestamp: string;  // ISO 8601
  symbol: string;
  mint: string;
  price: number;
  marketCap: number;
}

/** 某一天的信号合集 */
export interface DailySignals {
  date: string;       // YYYY-MM-DD (UTC)
  signals: SignalRecord[];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): DailySignals[] {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as DailySignals[];
    }
  } catch {
    // ignore
  }
  return [];
}

function save(data: DailySignals[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('WARN', `[SignalStore] Failed to persist: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 记录一条信号。每次检测到买入信号时调用。
 * 按 UTC 日期分组，最多保留最近 60 天。
 */
export function recordSignal(
  symbol: string,
  mint: string,
  price: number,
  marketCap: number,
): void {
  const data  = load();
  const today = todayUtc();

  let day = data.find((d) => d.date === today);
  if (!day) {
    day = { date: today, signals: [] };
    data.push(day);
  }

  day.signals.push({
    timestamp: new Date().toISOString(),
    symbol,
    mint,
    price,
    marketCap,
  });

  // 按日期降序，只保留最近 60 天
  data.sort((a, b) => b.date.localeCompare(a.date));
  if (data.length > 60) data.splice(60);

  save(data);
}

/**
 * 读取历史信号，返回最近 N 天（默认 7）。
 * 按日期降序（最新的在前）。
 */
export function getSignalHistory(days = 7): DailySignals[] {
  const data = load();
  data.sort((a, b) => b.date.localeCompare(a.date));
  return data.slice(0, Math.min(days, 60));
}
