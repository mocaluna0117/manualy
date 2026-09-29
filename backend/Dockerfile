# ==== ビルドステージ: TypeScriptのコンパイルとPrismaクライアント生成 ====
FROM node:24-slim AS build
WORKDIR /app

# 依存定義だけ先にコピーしてinstall(コード変更時にここのキャッシュが効く)
COPY package*.json ./
RUN npm ci

# Prismaクライアントを生成(generated/はGit管理外なのでビルド時に作る)
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npx prisma generate

COPY src ./src
RUN npm run build

# ==== 実行ステージ: 本番実行に必要なものだけを載せた軽量イメージ ====
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# DBのTLS証明書を検証するためのCA。どれを使うかは実行時のDATABASE_SSL_CAで決める。
#
# Supabaseの証明書は公的CAではなく自前のCA(O=Supabase Inc /
# CN=Supabase Intermediate 2021 CA)で署名されている。ハンドブックには
# 「公的CAで検証できる」とあるが誤りで、システムの信頼ストアだけでは
# verify-full が certificate verify failed になる(psqlで実測)。
# そのため証明書をイメージに同梱する。有効期限は2030-03まで。
#
# **Cloud Run では DATABASE_SSL_CA=/app/certs/supabase-ca.crt を必ず渡すこと。**
# 同梱しただけでは使われない。未設定だと node-pg は sslmode の無い
# Supabaseの接続文字列をそのまま解釈して**平文**で繋ぐ
# (pg_stat_ssl.ssl = false を実測)。入れ忘れたまま起動しないよう、
# src/config/db-tls.ts が起動時に接続先を見て止める。
# ENV でここに既定値を置かないのは、同じイメージをAWS(RDS)でも使うため
# (taskdefが渡す /app/certs/rds-ca.pem を上書きしてしまう)。
COPY certs/ /app/certs/

# AWS(RDS)のCA。切り替え日まではこちらが本番で、ECSのtaskdefが
# DATABASE_SSL_CA=/app/certs/rds-ca.pem を指している。
# 束は随時更新されるので同梱せずビルド時に取り直す(古い写しを抱えて
# 切り替え前のAWSが繋がらなくなるほうが痛い)。
# Cloud Run 用のイメージでは使わないので --build-arg WITH_RDS_CA=0 で省ける。
# 既定は取得したまま: 引数を付け忘れた既存のビルド手順(README/scripts)が
# 今までどおり動き、AWS版が起動時にCAを見失わないようにするため。
ARG WITH_RDS_CA=1
RUN if [ "$WITH_RDS_CA" != "0" ]; then \
      mkdir -p /app/certs && node -e "\
        fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem') \
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }) \
          .then(t => require('fs').writeFileSync('/app/certs/rds-ca.pem', t))"; \
    fi

# Cloud Run は待ち受けポートを $PORT で渡してくる(main.tsが読む)。
# EXPOSE は説明のためで、実際の値は実行時の環境変数で決まる
EXPOSE 3000
CMD ["node", "dist/src/main"]
