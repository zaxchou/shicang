#!/bin/sh
# NAS 版本更新：构建指定版本的镜像并重建容器，然后做健康检查与版本校验。
# 用法（在 NAS 上，项目根目录）：sudo sh deploy/nas-update.sh 0.1.3
# 说明：本 NAS 的 docker 需 root 权限；项目文件经共享目录已自动同步，无需上传。
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <版本号>（对应 releases/<版本号>/）" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
REL="$PROJ/releases/$VER"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"

export PATH=/usr/local/bin:$PATH

[ -f "$REL/manifest.json" ] || { echo "错误：$REL/manifest.json 不存在，不是有效发布包" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "错误：$ENV_FILE 不存在，先完成首次部署配置" >&2; exit 1; }
grep -q "MYINFOBASE_TAG=" "$ENV_FILE" || { echo "错误：.env 缺少 MYINFOBASE_TAG" >&2; exit 1; }

echo "== 更新 myinfobase -> $VER =="
sed -n '1,6p' "$REL/manifest.json"

# 磁盘粗检（构建需约 1GB 余量）
AVAIL_KB=$(df -Pk "$(dirname "$PROJ")" | awk 'NR==2 {print $4}')
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 1048576 ]; then
  echo "错误：可用空间不足 1GB（${AVAIL_KB}KB）" >&2
  exit 1
fi

echo "[1/4] 构建镜像 myinfobase:$VER"
docker build -t "myinfobase:$VER" "$REL"

echo "[2/4] 更新 .env 版本标签"
sed -i "s/^MYINFOBASE_TAG=.*/MYINFOBASE_TAG=$VER/" "$ENV_FILE"

echo "[3/4] 重建容器"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

echo "[4/4] 健康检查"
PORT=$(grep -E '^MYINFOBASE_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-4317}
# 探针独立成脚本（每次请求自带超时 + 单调整体截止，评审 R6），失败时保持本脚本原有的 exit 2
if ! sh "$PROJ/deploy/health-wait.sh" "$PORT" "$VER" 180; then
  echo "错误：健康检查未通过，查看日志：docker logs myinfobase" >&2
  exit 2
fi
echo "完成：健康检查通过，版本 $VER 已上线（http://$(grep -E '^NAS_IP=' "$ENV_FILE" | cut -d= -f2):$PORT）"
exit 0
