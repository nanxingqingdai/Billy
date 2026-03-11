#!/bin/bash
# BillyCode — Mac Mini 一键部署脚本
# 运行方式：bash deploy/setup-mac.sh

set -e

echo "========================================"
echo "  BillyCode Mac Mini 部署"
echo "========================================"

# 1. 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js 未安装，请先安装："
  echo "   brew install node"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. 检查 npm
if ! command -v npm &>/dev/null; then
  echo "❌ npm 未找到"
  exit 1
fi
echo "✅ npm $(npm -v)"

# 3. 安装依赖
echo ""
echo "📦 安装依赖..."
npm install

# 4. 检查 pm2
if ! command -v pm2 &>/dev/null; then
  echo ""
  echo "📦 安装 pm2..."
  npm install -g pm2
fi
echo "✅ pm2 $(pm2 -v)"

# 5. 检查 .env
if [ ! -f ".env" ]; then
  echo ""
  echo "❌ .env 文件不存在，请先从 Windows 电脑复制 .env 文件到此目录"
  exit 1
fi
echo "✅ .env 已存在"

# 6. 启动
echo ""
echo "🚀 启动 BillyCode..."
pm2 start ecosystem.config.js --env production

echo ""
echo "========================================"
echo "  部署完成！"
echo "  查看日志: pm2 logs billycode"
echo "  停止:     pm2 stop billycode"
echo "  重启:     pm2 restart billycode"
echo "  开机自启: pm2 startup && pm2 save"
echo "========================================"
