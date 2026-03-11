/**
 * 独立运行 Moonshot 频道监听器（单次扫描模式，用于测试）
 *
 * Usage:
 *   npx ts-node scripts/runMoonshotListener.ts
 *
 * 会立即抓取一次 https://t.me/s/moonshotlistings，打印发现的 CA
 * 并逐一跑前置条件检查。结果写入 watchlist.json + moonshot-seen.json。
 */

import 'dotenv/config';
import { startMoonshotListener } from '../src/services/moonshotListener';

console.log('═'.repeat(68));
console.log('  Moonshot 频道单次扫描');
console.log('═'.repeat(68));

startMoonshotListener();

// 给足时间让所有异步检查跑完（最多 3 分钟）
setTimeout(() => {
  console.log('\n═'.repeat(68));
  console.log('  扫描完成，退出');
  console.log('═'.repeat(68));
  process.exit(0);
}, 3 * 60 * 1_000);
