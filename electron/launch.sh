#!/usr/bin/env bash
# 半人马AI-万象 桌面启动器。
# 双击 .desktop 时不走 shell 配置，代理这些变量得在这里补齐。
set -euo pipefail
cd "$(dirname "$0")/.."

# 没有 key 就没法造助手，早点说清楚，别让用户对着空界面猜。
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi

export NODE_USE_ENV_PROXY=1
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

LOG_DIR="$HOME/.cache/wanxiang"
mkdir -p "$LOG_DIR"
# 双击启动没有终端，把 electron 自己的输出也留一份。
# --ozone-platform=x11：Wayland 下 Vulkan 不兼容，Electron 会报错并可能起不来。
exec ./node_modules/electron/dist/electron --no-sandbox --ozone-platform=x11 electron/main.cjs "$@" \
  >>"$LOG_DIR/desktop.log" 2>&1
