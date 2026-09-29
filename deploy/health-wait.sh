#!/bin/sh
# 健康检查等待（nas-update.sh 第 4 步调用，也可独立运行——回归测试跑的就是它）。
# 用法：sh health-wait.sh <PORT> <VERSION> [TIMEOUT_SEC]
# 退出码：0=就绪且版本一致；2=就绪但版本不符（部署事故，立刻失败）；1=超时；3=没有可用的抓取工具
#
# 两条来自评审 R6 的纪律：
#   1) **每次请求自带超时**：服务"连上了但不回包"时，没有超时的单次 wget/curl 会无限阻塞，
#      后面的计数与截止逻辑全部失效（wget 用 -T/-t——GNU 与 BusyBox 同形；curl 用 -m）；
#   2) **单调整体截止**：以绝对截止时间戳控制循环、每轮先查剩余时间——"90 次 × 2 秒 ≈ 3 分钟"
#      的说法依赖每次请求都很快返回，前提并不成立。
set -u
PORT=${1:?用法: health-wait.sh <PORT> <VERSION> [TIMEOUT_SEC]}
VER=${2:?版本号必填}
TOTAL=${3:-180}
URL="http://127.0.0.1:$PORT/api/health"

if command -v wget >/dev/null 2>&1; then
  FETCH=wget
elif command -v curl >/dev/null 2>&1; then
  FETCH=curl
else
  echo "错误：找不到 wget 或 curl，无法做健康检查" >&2
  exit 3
fi

DEADLINE=$(( $(date +%s) + TOTAL ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$FETCH" = wget ]; then
    BODY=$(wget -T 5 -t 1 -qO- "$URL" 2>/dev/null || true)
  else
    BODY=$(curl -m 5 -fsS "$URL" 2>/dev/null || true)
  fi
  case "$BODY" in
    *'"ready":true'*)
      case "$BODY" in
        *"\"version\":\"$VER\""*)
          exit 0
          ;;
        *)
          echo "错误：health 版本与 $VER 不一致：$BODY" >&2
          exit 2
          ;;
      esac
      ;;
  esac
  sleep 2
done
echo "错误：健康检查超时（${TOTAL}s），查看日志：docker logs myinfobase" >&2
exit 1
