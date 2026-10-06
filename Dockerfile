# score-viewer：只读乐谱预览静态站点（供 ScoreFlow 侧栏 iframe 内嵌）。
# 与 HPCLINK 一致：位于 submodules/jianpu-editor，独立构建上下文与镜像。

# 构建阶段：安装依赖并以 /api/score-viewer/ 作为资源基础路径打包
FROM node:22-alpine AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}
COPY . .
RUN BASE_PATH=/api/score-viewer/ npm run build

# 运行阶段：nginx 托管 dist（由 ScoreFlow API 代理 /score-viewer/* 转发到此）
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
