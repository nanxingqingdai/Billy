import 'dotenv/config';
import axios from 'axios';
import { isTelegramConfigured, notifyBuySignal } from '../src/services/telegramNotifier';

async function main() {
  console.log('TG_BOT_TOKEN:', process.env.TG_BOT_TOKEN ? '✅ 已设置' : '❌ 未设置');
  console.log('TG_CHAT_ID  :', process.env.TG_CHAT_ID   ? '✅ 已设置' : '❌ 未设置');
  console.log('Configured  :', isTelegramConfigured());

  if (!isTelegramConfigured()) {
    console.error('缺少凭证，退出');
    process.exit(1);
  }

  // 1. 基础连通测试
  console.log('\n[1] 发送基础测试消息...');
  const token  = process.env.TG_BOT_TOKEN!;
  const chatId = process.env.TG_CHAT_ID!;
  const res = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: '🤖 <b>BillyCode 测试消息</b>\nTelegram 通知连接正常！',
    parse_mode: 'HTML',
  }, { timeout: 10_000 });
  console.log('✅ 基础消息发送成功, message_id:', res.data.result.message_id);

  // 2. 完整买入信号通知测试
  console.log('\n[2] 发送模拟买入信号...');
  await notifyBuySignal({
    symbol:          'BUZZ',
    mint:            '9DHe3pycTuymFk4H4bbPoAJ4hQrr2kaLDF6J6aAKpump',
    athMarketCapUsd: 189_420_000,
    drawdownPct:     99.73,
    lowAmpBars:      9,
    lowVolBars:      10,
    volThresholdUsd: 20_000,
    path:            'mature',
    priceImpactPct:  0.04,
    buyAmountUsdt:   30,
  });
  console.log('✅ 买入信号通知发送完成');
}

main().catch(e => {
  console.error('[FATAL]', e.response?.data ?? e.message);
  process.exit(1);
});
