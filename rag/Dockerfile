FROM python:3.13-slim
WORKDIR /app

# 依存定義だけ先にコピーしてinstall(キャッシュを効かせる)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# DBのTLS証明書を検証するためのCA。どれを使うかは実行時のDATABASE_SSL_CAで決める。
#
# Supabaseの証明書は公的CAではなく自前のCA(O=Supabase Inc /
# CN=Supabase Intermediate 2021 CA)で署名されているため、システムの
# 信頼ストアだけでは verify-full が通らない(psqlで実測)。同梱しておく。
#
# **Cloud Run では DATABASE_SSL_CA=/app/certs/supabase-ca.crt を必ず渡すこと。**
# 同梱しただけでは使われない。未設定だと psycopg は sslmode 既定の prefer で
# 繋ぐので、暗号化はされても相手が本物かを確認しない(検証なし)。
# ENV でここに既定値を置かないのは、同じイメージをAWS(RDS)でも使うため
# (taskdefが渡す /app/certs/rds-ca.pem を上書きしてしまう)。
COPY certs/ /app/certs/

# AWS(RDS)のCA。切り替え日まではこちらが本番で、ECSのtaskdefが
# DATABASE_SSL_CA=/app/certs/rds-ca.pem を指している。
# 束は随時更新されるので同梱せずビルド時に取り直す。
# Cloud Run 用のイメージでは使わないので --build-arg WITH_RDS_CA=0 で省ける。
# 既定は取得したまま: 引数を付け忘れた既存のビルド手順(README/scripts/test.sh)が
# 今までどおり動き、AWS版が起動時にCAを見失わないようにするため。
ARG WITH_RDS_CA=1
RUN if [ "$WITH_RDS_CA" != "0" ]; then \
      mkdir -p /app/certs && python -c "\
import urllib.request; \
urllib.request.urlretrieve( \
    'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', \
    '/app/certs/rds-ca.pem')"; \
    fi

# 待ち受けポートは実行時に決まる。Cloud Run は $PORT(既定8080)を渡してきて、
# そこで待っていないと「コンテナが起動しなかった」と判定される。
# ECS/docker-composeでは渡されないので、そのときは今までどおり8000。
#
# exec形式のCMDでは環境変数が展開されないのでシェルを挟む。
# ただし exec を付けてuvicornをPID 1にする(付けないとシェルがPID 1のままで、
# 停止時のSIGTERMがuvicornに届かず、Cloud Runの終了が毎回タイムアウトする)
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
