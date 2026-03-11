import 'dotenv/config';
import axios from 'axios';

async function main() {
  const token = process.env.TG_BOT_TOKEN ?? '';
  const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, { timeout: 10_000 });
  const updates = res.data.result as any[];

  if (updates.length === 0) {
    console.log('⚠️  没有收到任何消息。');
    console.log('请先在 Telegram 里给你的 Bot 发一条任意消息，再重新运行此脚本。');
    return;
  }

  console.log('找到以下 Chat ID：');
  const seen = new Set<number>();
  for (const u of updates) {
    const msg = u.message ?? u.channel_post;
    if (msg && !seen.has(msg.chat.id)) {
      seen.add(msg.chat.id);
      console.log(`  Chat ID: ${msg.chat.id}  | 类型: ${msg.chat.type}  | 用户名: ${msg.from?.username ?? '—'}`);
    }
  }
  console.log('\n把上面的 Chat ID 填入 .env 的 TG_CHAT_ID=');
}

main().catch(e => console.error('[FATAL]', e.response?.data ?? e.message));
