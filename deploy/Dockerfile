# myinfobase 生产镜像：多阶段构建（构建工具不进入生产镜像）
# 构建必须在目标架构上执行（群晖上由 Container Manager / docker build 完成）
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
# 使用国内镜像源避免 npmjs 直连超时（npm10 会自动把 lockfile 中的 registry 主机替换为镜像）
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-fund --no-audit
COPY tsconfig.server.json tsconfig.web.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
# 语音转录（ASR）：网关只收 wav/mp3，源库语音全是 m4a，服务端必须能转码（apk 版本，比静态构建小）
RUN apk add --no-cache ffmpeg
COPY --from=build /build/dist ./dist
COPY config ./config
COPY data-seed ./data-seed
# 生产数据通过挂载提供：/app/data（读写）、/app/backups（读写）
VOLUME ["/app/data", "/app/backups"]
EXPOSE 4317
USER node
HEALTHCHECK --interval=60s --timeout=8s --start-period=120s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4317}/api/health" >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server/index.js"]
