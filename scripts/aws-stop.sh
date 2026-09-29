#!/usr/bin/env bash
# 節約用の一時停止スクリプト。
#
# 金額は 2026-09-10 の実測(./scripts/check-credits.sh の直近30日 / ap-northeast-1)。
#
# 止まるもの(合計 約$52/月)
#   - Fargateタスク2本 … 約$27/月
#   - RDSインスタンス(db.t4g.micro) … 約$18/月
#   - ECSタスクが持つ公開IPv4 2つ … 約$7/月
#
# 止まらないもの(合計 約$31/月 = 約$1.05/日)。
# **以前ここに書いていた「ALB約$18/月・ストレージ類約$3/月」=約$21/月は誤り。**
#   - ALB … 約$17/月(check-credits.sh の内訳で $17.46/30日)
#   - 公開IPv4 2つ(ALBが2AZぶん持つ) … 約$7/月  ← 以前これを数えていなかった
#   - RDSのバックアップ保存 … 約$3.5/月
#   - RDSのストレージ(gp3) … 約$2.8/月
#   - Secrets Manager … 約$0.8/月
#   - ECR・S3 … 約$0.1/月
#
#   check-credits.sh の内訳に出る「Amazon Virtual Private Cloud $15.15/30日」は
#   ALBの2つ + ECSタスクの2つ = 計4アドレスぶん。止めるとタスクぶんが消えて半分になる。
#   → 退路として残す$25がもつのは**約24日**($1.05/日)。それ以上空けるなら
#     ALBの削除まで検討する(docs/deployment-plan.md「8. 完全撤収(teardown)手順」)
#
# 注意: RDSの停止は7日で自動的に再開される(AWSの仕様)。
# 様子見の期間は週1回これを流し直さないと、動いていた頃の$2.81/日に戻る。
set -euo pipefail

CLUSTER=manual-search

echo "== ECSサービスを0タスクにする =="
for svc in backend rag; do
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
    --desired-count 0 --query "service.[serviceName,desiredCount]" --output text
done

echo "== RDSを停止する =="
aws rds stop-db-instance --db-instance-identifier manual-search-db \
  --query "DBInstance.DBInstanceStatus" --output text

echo "完了。再開は scripts/aws-start.sh"
