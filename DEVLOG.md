# BillyCode — Solana Memecoin 量化交易机器人 开发日志

> 本文件记录所有开发决策、模块设计和待办事项，供 AI 助手跨会话快速恢复上下文。

---

## 项目概览

**目标**：自动扫描 Solana Memecoin，识别低波动缩量买入信号，自动执行买卖，通过实时 Dashboard 监控。

**技术栈**
- TypeScript + ts-node
- `@solana/web3.js ^1.98.4`
- `@jup-ag/api ^6.0.48`（swap 执行）
- `axios ^1.13.6`（Birdeye API 请求）
- `express ^5.2.1` + `socket.io ^4.8.3`（实时 Dashboard）
- pm2（生产环境进程守护）

**运行方式**
```bash
npm run dev          # 开发
npm run start:prod   # pm2 生产
npx ts-node scripts/testPreConditions.ts <mint>  # 测试单个代币前置条件
```

---

## 目录结构

```
src/
  index.ts            — 入口：启动 HTTP 服务器 + 监控循环
  monitor.ts          — 主循环：每隔 N 秒扫描 watchlist，触发买卖
  server.ts           — Express + Socket.io 实时 Dashboard
  config/
    env.ts            — .env 读取
    riskConfig.ts     — 风控参数（热更新，持久化到 risk-config.json）
    watchlist.ts      — 监控列表（持久化到 watchlist.json，支持增删改）
  services/
    jupiter.ts        — Jupiter v6 API：报价、执行 swap、余额查询
    birdeye.ts        — Birdeye API：价格、OHLCV、前置条件检查
  strategies/
    lowVolBuy.ts      — 独立的低波动买入纯函数（备用，未接入主流程）
    batchSell.ts      — 批量卖出策略
    riskManager.ts    — 7 项风控检查
  utils/
    logger.ts         — 日志（含文件轮转）
    positionStore.ts  — 仓位持久化
    keypair.ts        — 钱包工具
    emitter.ts        — 事件总线
    errorHandler.ts   — 全局错误处理
scripts/
  testPreConditions.ts — 诊断脚本，打印代币原始数据 + 前置条件结果
```

---

## 核心买入流程

```
monitor.ts → scanToken()
  │
  ├─ [有持仓] → runPositionChecks() → 止损/超时平仓 or 批量卖出
  │
  └─ [无持仓]
        │
        ├─ checkEntryPreConditions(mint)   ← birdeye.ts，三路径前置过滤
        │     └─ 不通过 → return（日志：Pre-condition blocked: ...）
        │
        ├─ isLowVolContraction(candles)    ← birdeye.ts，振幅+缩量主信号
        │     └─ 未触发 → return（日志：No signal）
        │
        ├─ runBuyChecks()                  ← riskManager.ts，7 项风控
        │     └─ 不通过 → return（日志：Buy blocked by risk: ...）
        │
        └─ buyWithUsdt() / executeSwap()  ← jupiter.ts，实际执行
```

---

## 前置条件逻辑（checkEntryPreConditions）

所在文件：`src/services/birdeye.ts`

### 分支判断树

```
1. 获取 TokenOverview（当前市值、价格）
2. 获取最近 401 根日K → 计算 ATH 价格 → 估算 ATH 市值
3. 计算跌幅 drawdownPct = (ATH MC - 当前 MC) / ATH MC × 100
4. 估算代币年龄 ageDays（第一根日K时间戳到现在）

isYoung = ageDays ≤ 40 天
requiredDrawdown = isYoung ? 90% : 80%

if drawdownPct < requiredDrawdown → ❌ 拦截

if isYoung:
    取最近 11 根 4H K 线，排除当前未收盘 → window4h(10根)
    isLargeYoung = ATH MC > $20M

    if isLargeYoung:   [Young-large]
        振幅 < 20% 的根数 ≥ 4 → 否则 ❌
        成交量 < $50k 的根数 ≥ 4 → 否则 ❌
    else:              [Young-small]
        振幅 < 10% 的根数 ≥ 4 → 否则 ❌
        成交量 < $10k 的根数 ≥ 4 → 否则 ❌

else (mature, age > 40天):
    取最近 11 根日K，排除当前未收盘 → window1d(10根)
    volThreshold = ATH MC ≥ $100M ? $20k : $10k
    振幅 ≤ 15% 的天数 ≥ 3 → 否则 ❌
    成交量 < volThreshold 的天数 ≥ 3 → 否则 ❌

→ ✅ 通过
```

### 三路径参数速查

| 路径 | 年龄 | ATH MC | 跌幅要求 | K线 | 振幅阈值 | 振幅最少根 | 成交量阈值 | 成交量最少根 |
|------|------|--------|----------|-----|----------|------------|------------|------------|
| Young-small | ≤40天 | ≤$20M | ≥90% | 4H | <10% | 4 | $10k | 4 |
| Young-large | ≤40天 | >$20M | ≥90% | 4H | <20% | 4 | $50k | 4 |
| Mature | >40天 | 任意 | ≥80% | 1D | ≤15% | 3 | $10k/$20k* | 3 |

*Mature: ATH MC ≥ $100M 时用 $20k，否则 $10k

### ATH 市值估算方式
```
estimatedSupply = currentMarketCap / currentPrice
athMarketCapUsd = max(历史日K高价) × estimatedSupply
```
⚠️ 假设流通量不变，对有 burn/mint 的代币可能有偏差。
待验证：Birdeye `TokenOverview` 是否返回 `supply` 字段（如有，应直接使用）。

### ⚠️ 重要：Birdeye OHLCV `v` 字段单位问题（已修复）

Birdeye `/defi/ohlcv` 返回的 `v` 字段是**代币数量（token units）**，不是 USD。
直接使用 `c.v` 会导致成交量数据高出实际约 1000 倍。

**正确的 USD 成交量计算：**
```typescript
const volUsd = c.v * c.c;   // token数量 × 收盘价(USD/token) = USD成交量
```

**验证数据（2026-03-11）：**
- 114514 日K：`v × close` ≈ $3,568~$28,805，与 DexScreener $11,957/24h 吻合 ✅
- BigTrout 4H：`v × close` ≈ $1,891~$22,918，与 DexScreener $65,372/24h 吻合 ✅

已修复位置：`src/services/birdeye.ts` → `checkEntryPreConditions()` 中的 `lowVolBars` 过滤条件。
`isLowVolContraction()` 使用比例比较（latest.v vs avg.v），不受此影响，无需修改。

---

## 风控系统（riskManager.ts）

买入前的 7 项检查（`runBuyChecks`）：

| 规则 | 条件 |
|------|------|
| DAILY_LOSS | 今日累计亏损 < maxDailyLossUsdt |
| MAX_POSITIONS | 当前持仓数 < maxOpenPositions |
| LOW_SOL | SOL余额 > 0.05（<0.1 时警告但不拦截） |
| MIN_RESERVE | 买入后 USDT 余额 ≥ minUsdtReserve |
| PRICE_IMPACT | Jupiter 报价价格冲击 < maxPriceImpactPct |

持仓中的检查（`runPositionChecks`）：

| 规则 | 条件 |
|------|------|
| STOP_LOSS | 当前价格未跌破入场价 × (1 - stopLossPct/100) |
| MAX_HOLD | 持仓时间 < maxHoldHours |

---

## Jupiter 服务（jupiter.ts）

- `getQuote(params)` — Jupiter v6 /quote，带指数退避重试（最多5次，ECONNRESET/ETIMEDOUT）
- `executeSwap(quote, dryRun)` — 序列化交易、签名、发送、确认
- `buyWithUsdt(mint, amount, slippage, dryRun)` — USDT → Token
- `sellToUsdt(mint, rawAmount, slippage, dryRun)` — Token → USDT
- `getSolBalance()` / `getTokenBalance(mint)` — 余额查询

DRY_RUN=true 时跳过链上发送，返回 txid='dry-run'。

---

## Birdeye 服务（birdeye.ts）

- `getTokenPrice(mint)` — 实时价格 + 24h 涨跌幅
- `getRecentOHLCV(mint, interval, limit)` — 最近 N 根 K 线（单次请求）
- `getAllOHLCV(mint, interval, timeFloor?)` — 分页拉取完整历史
- `getTokenOverview(mint)` — 完整代币信息（市值、流动性、持有人等）
- `isLowVolContraction(candles, opts)` — 主信号：振幅 + 缩量检测
- `checkEntryPreConditions(mint)` — 前置过滤（见上方详细说明）

---

## 测试脚本（scripts/testPreConditions.ts）

```bash
npx ts-node scripts/testPreConditions.ts <mint1> [mint2] [mint3]
```

输出四段：
1. **TOKEN OVERVIEW** 原始字段
2. **日K线表格**（最近10根，自动标注振幅/成交量是否达标）
3. **4H K线表格**（最近10根，自动标注振幅/成交量是否达标）
4. **checkEntryPreConditions() 最终结果**

---

## OKX DEX V6 API 全量探测结果（2026-03-11）

使用 `scripts/exploreOkxDex.ts` 对 SOL（成熟代币）探测 12 个 V6 端点，结论如下：

### ✅ 可用端点

| 端点 | 说明 | 关键字段 |
|------|------|----------|
| `GET /api/v6/dex/aggregator/all-tokens` | Solana 支持代币列表（~200个） | `tokenSymbol`, `tokenContractAddress`, `decimals` |
| `GET /api/v6/dex/aggregator/quote` | Swap 报价 | `fromTokenAmount`, `toTokenAmount`, `priceImpactPercent`, `estimateGasFee`, `tradeFee`, **`tokenUnitPrice`（直接 USD 价格！）** |
| `GET /api/v6/dex/aggregator/get-liquidity` | 指定代币对支持的 DEX 协议列表 | DEX `name`, `id`, `logo`（无深度数据）|

### ❌ 404 端点（V6 不存在或需不同参数）

`/aggregator/token-detail`, `/aggregator/current-price`, `/market/token-price`, `/market/volume`, `/market/token-overview`, `/market/ticker`, `/market/token-holder`, `/market/transactions`

### ⚠️ 特殊情况

`/market/candles` 返回 code=51001："No trading activities or price data found"
→ SOL 原生地址（`So1111...112`）不适用；该端点针对链上 DEX 交易对，不支持原生 SOL。

### 重要发现：quote 响应内嵌直接 USD 价格

```json
"fromToken": {
  "tokenSymbol": "wSOL",
  "tokenUnitPrice": "85.29"   // ← 直接 USD 单价，无需推导
},
"toToken": {
  "tokenSymbol": "USDC",
  "tokenUnitPrice": "0.99986"
},
"priceImpactPercent": "-0.05",
"estimateGasFee": "172000",
"tradeFee": "0.00042645"
```

`tokenUnitPrice` 是直接的 USD 价格，不需要用 USDC→token 反向推导。
当前 `getOkxTokenPrice()` 实现通过 1 USDC→token 报价再取倒数的方式推导价格，仍然有效但多一次 API 调用。

### OKX DEX V6 定位结论

OKX DEX V6 在 Solana 上主要是**聚合器 API**，不是行情数据 API：
- ✅ 适合：交叉验证价格（直接读 `tokenUnitPrice`）、检查代币是否在支持列表、获取 swap 报价和手续费
- ❌ 不适合：K线/OHLCV、历史成交量、持有人分布、实时 ticker（这些需要 Birdeye/DexScreener）

---

## DexScreener 服务（dexscreener.ts）

- `getDexScreenerSummary(mint)` — 聚合所有交易对的价格/成交量/流动性/代币年龄
- `crossValidate(birdeyePrice, birdeyeVol, ds)` — 交叉验证，价格差 ≤5% 为 OK，成交量差 ≤20% 为 OK
- 代币年龄用 `pairCreatedAt`（比 Birdeye 第一根日K更精确）
- 不需要 API Key，公开接口

---

## 真实 CA 测试验证记录（2026-03-11）

测试了三个代币，验证三条分支路径：

| CA | 预期 | 实际 | 路径 |
|----|------|------|------|
| `AGdGTQa8iRnSx4fQJehWo4Xwbh1bzTazs55R6Jwupump`（114514） | 通过 | ✅ 通过 | Mature（>40天，跌幅≥80%，振幅/成交量达标） |
| `EPuZ1X6pPzac3ELPsT59LStmgaSr4kBJvaAbL15Fpump`（Distorted） | 拦截（活跃） | ✅ 被跌幅不足拦截 | Young-small，drawdown < 90% |
| `EKwF2HD6X4rHHr4322EJeK9QBGkqhpHZQSanSUmWkecG`（BigTrout） | 可能通过 | ✅ 通过 | Young-large（ATH MC >$20M，4H K线振幅+成交量均达标） |

同时发现并修复了 Birdeye OHLCV `v` 字段单位问题：
- **问题**：`v` 是代币数量（token units），不是 USD
- **修复**：改用 `c.v * c.c`（token数量 × 收盘价 = USD成交量）
- **验证**：与 DexScreener 数据误差 <3%

---

## Moonshot TG 频道监听器（moonshotListener.ts）

**源文件：** `src/services/moonshotListener.ts`
**测试脚本：** `scripts/runMoonshotListener.ts`

### 工作原理

1. 定时轮询 `https://t.me/s/moonshotlistings`（公开频道，无需凭证）
2. 用正则提取页面中所有 Solana base58 地址（32–44 字符，过滤系统程序地址）
3. 与 `moonshot-seen.json`（已处理记录）和当前 watchlist 去重
4. 对新 CA 逐一调用 `checkEntryPreConditions()`
5. 通过则自动调用 `addToken()` 加入 watchlist，并记录到 `moonshot-seen.json`

### 配置参数

| 参数 | 值 | 说明 |
|------|----|------|
| 轮询间隔 | 5 分钟 | `POLL_INTERVAL_MS` |
| 新代币默认 maxBuyUsdt | $30 | 可在 watchlist.json 手动调整 |
| 新代币默认 slippageBps | 300 (3%) | memecoin 流动性较低，留足余量 |
| 卖出批次 | 1.5x/34%, 2.0x/33%, 3.0x/33% | 三档止盈 |

### 监控频道

| 频道 | URL |
|------|-----|
| moonshotlistings | https://t.me/s/moonshotlistings |
| moonshotnews | https://t.me/s/moonshotnews |

两个频道并发抓取，取并集后统一过滤。

### RWA / 股票代币过滤规则

- Symbol 匹配常见股票代码（AAPL/TSLA/NVDA/META 等约 60 个）
- Name 包含关键词：stock / rwa / equity / tokenized / treasury / etf / bond / corp 等

### 扫描结果（2026-03-11，双频道）

两频道并集 37 个 CA → **12 个通过，加入 watchlist：**

KIND / FTP / STREAM / $Runner / QTO / NYX / pibble / CELL / PMX / CAP / LION / Rome / MODRIC

被拦截原因：跌幅不足、振幅过大、成交量过高

### 已知小问题

- 部分非 mint 的 base58 字符串会被 Birdeye 返回 400，直接跳过，不影响运行
- `moonshot-seen.json` 记录所有已处理 CA，避免重复检查

---

## 待办 / 已知问题

- [ ] 验证 `TokenOverview` 真实 API 响应是否有 `supply` 字段，若有则改用精确流通量
- [x] 用真实 CA 跑 `testPreConditions.ts`，验证三条路径的分支逻辑 ✅
- [x] 发现并修复 Birdeye OHLCV `v` 字段单位问题（token units，非 USD）✅
- [x] 新增 DexScreener 交叉验证服务（`src/services/dexscreener.ts`）✅
- [x] 新增 OKX DEX API 并全量探测 V6 端点 ✅
- [x] OKX V5 → V6 迁移（V5 返回 code=50050 已废弃）✅
- [x] 新增 Moonshot TG 频道自动监听器，自动筛选并加入 watchlist ✅
- [x] 新增 Telegram 买入信号通知（telegramNotifier.ts），信号触发时推送到个人 TG ✅
- [x] TG通知格式改进：市值/24h涨跌来自DexScreener，年龄用pairCreatedAt精确计算，带路径标签和ATH市值 ✅
- [x] EntryPreConditions 增加 path 字段（mature/young-small/young-large）✅
- [x] Mac Mini pm2 部署配置（ecosystem.config.js + deploy/setup-mac.sh）✅
- [ ] 验证 Jupiter API 网络连通性（可单独跑 `getQuote` 测试）
- [ ] watchlist.json 填入真实代币配置，跑完整 dry-run
- [ ] 评估前置条件参数（振幅/成交量阈值）是否过严 / 过松，根据实盘数据调整
- [ ] 考虑改用 quote 响应中的 `tokenUnitPrice` 直接获取价格，减少一次 API 调用

---

## 配置文件

| 文件 | 说明 |
|------|------|
| `.env` | BIRDEYE_API_KEY, WALLET_PRIVATE_KEY, RPC_URL, DRY_RUN, OKX_PROJECT_ID, OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE 等 |
| `watchlist.json` | 监控代币列表，运行时可热编辑 |
| `risk-config.json` | 风控参数，运行时可通过 Dashboard 修改 |
| `positions.json` | 当前持仓，重启后自动恢复 |
| `bot.log` | 运行日志（含文件轮转） |

---

*最后更新：2026-03-11*
