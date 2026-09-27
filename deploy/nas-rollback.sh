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

sed -i "s/^MYINFOBASE_TAG=.*/MYINFOBASE_TAG=$VER/" "$ENV_FILE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate
echo "已回滚到 $VER"
