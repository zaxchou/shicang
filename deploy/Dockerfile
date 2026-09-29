# myinfobase 生产镜像（v0.13.2 起单阶段：不在镜像里编译）
# 构建仍在目标机器上执行（群晖上由 Container Manager / docker build 完成），但只搬运不再编译：
#
# 1) 去掉 build 阶段的理由：TS + vite 在 NAS 的 CPU 上要跑几分钟，而 dist 是纯 JS、架构无关
#    （target ES2022 / engines >=22 / 容器 node:22，runtime 依赖全是纯 JS 包、无原生模块），
#    本地 Windows 预编译的产物可以原样进镜像（release.ps1 负责现场构建并打进发布包）。
# 2) 部署耗时的真正大头是 npm ci 层缓存被打掉——那层只由 package.json/package-lock.json 决定，
#    所以 release.ps1 把发布包里的 version 归一成 0.0.0、真实版本另存 VERSION 文件：
#    依赖不变时这两层逐字节恒定，缓存永远命中（详见 release.ps1 注释与 docs/verification.md）。
#
# 镜像内容 = 运行时依赖（5 个纯 JS 包）+ ffmpeg + dist + config + data-seed。
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# 使用国内镜像源避免 npmjs 直连超时（npm10 会自动把 lockfile 中的 registry 主机替换为镜像）
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
# 语音转录（ASR）：网关只收 wav/mp3，源库语音全是 m4a，服务端必须能转码（apk 版本，比静态构建小）
RUN apk add --no-cache ffmpeg
COPY dist ./dist
# VERSION 放在依赖层之后：它每次发版都变，只应打掉「COPY dist」这一个本来就必变的层
COPY VERSION ./
COPY config ./config
COPY data-seed ./data-seed
# 生产数据通过挂载提供：/app/data（读写）、/app/backups（读写）
VOLUME ["/app/data", "/app/backups"]
EXPOSE 4317
USER node
HEALTHCHECK --interval=60s --timeout=8s --start-period=120s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4317}/api/health" >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server/index.js"]
