# ==== ビルドステージ: Viteで静的ファイルを生成 ====
FROM node:24-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_*はビルド時に埋め込まれる(実行時には変えられない)ので、build argsで受け取る
ARG VITE_GRAPHQL_URL
ARG VITE_COGNITO_AUTHORITY
ARG VITE_COGNITO_CLIENT_ID
ARG VITE_COGNITO_DOMAIN
ENV VITE_GRAPHQL_URL=$VITE_GRAPHQL_URL \
    VITE_COGNITO_AUTHORITY=$VITE_COGNITO_AUTHORITY \
    VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID \
    VITE_COGNITO_DOMAIN=$VITE_COGNITO_DOMAIN

RUN npm run build

# ==== 配信ステージ: nginxで静的ファイルを配る ====
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
