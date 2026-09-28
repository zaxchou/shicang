#!/bin/sh
# NAS 回滚：把 TAG 切回指定版本并重建容器（镜像仍在本地，无需重新构建）。
# 用法：sudo sh deploy/nas-rollback.sh 0.1.2
set -eu

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <版本号>（须为已构建过的镜像 tag）" >&2
  exit 1
fi
VER="$1"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ/deploy/production/.env"
COMPOSE_FILE="$PROJ/deploy/production/compose.yaml"
export PATH=/usr/local/bin:$PATH

docker image inspect "myinfobase:$VER" >/dev/null 2>&1 || {
  echo "错误：本地没有镜像 myinfobase:$VER；已有镜像：" >&2
  docker images "myinfobase" --format "{{.Tag}}" >&2
  exit 1
}

# 与 nas-update.sh 同样的守卫：缺这一行时 sed 会静默不改，容器仍跑旧版本却报"已回滚"
[ -f "$ENV_FILE" ] || { echo "错误：$ENV_FILE 不存在，先完成首次部署配置" >&2; exit 1; }
grep -q "MYINFOBASE_TAG=" "$ENV_FILE" || { echo "错误：.env 缺少 MYINFOBASE_TAG" >&2; exit 1; }

echo "== 回滚 myinfobase -> $VER =="
sed -i "s/^MYINFOBASE_TAG=.*/MYINFOBASE_TAG=$VER/" "$ENV_FILE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate

# 健康检查 + 版本核对：回滚是否真的生效必须以 health 为准
PORT=$(grep -E '^MYINFOBASE_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-4317}
i=0
while [ $i -lt 60 ]; do
  BODY=$(wget -qO- "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  case "$BODY" in
    *'"ready":true'*)
      case "$BODY" in
        *"\"version\":\"$VER\""*)
          echo "完成：已回滚到 $VER（http://$(grep -E '^NAS_IP=' "$ENV_FILE" | cut -d= -f2):$PORT）"
          exit 0
          ;;
        *)
          echo "错误：health 版本与 $VER 不一致：$BODY" >&2
          exit 2
          ;;
      esac
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
echo "错误：回滚后健康检查超时（2 分钟），查看日志：docker logs myinfobase" >&2
exit 2
