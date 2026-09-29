#!/usr/bin/env bash
# 一時停止(aws-stop.sh)からの再開スクリプト。**切り戻しのときもこれを使う。**
#
#   ./scripts/aws-start.sh
#
# RDSが使える状態になってからECSを起こす(逆だと起動時のDB接続で
# タスクが数回落ちる。最終的には自己回復するが、無駄な再起動を避ける)。
set -euo pipefail

CLUSTER=manual-search
DB=manual-search-db

echo "== RDSの状態を見る =="
STATUS="$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query "DBInstances[0].DBInstanceStatus" --output text)"
echo "RDS: $STATUS"

# 状態を見ずに start-db-instance を打つと、既に available のときに
# InvalidDBInstanceState で異常終了する。set -e があるので、そこで止まって
# **この下のECSを1タスクに戻す処理まで飛ばしてしまう**。
# 切り戻しの最中にこれをやると「コマンドは失敗、サービスは止まったまま」になる。
# だから stopped のときだけ start する。
case "$STATUS" in
  stopped)
    echo "== RDSを起動する =="
    aws rds start-db-instance --db-instance-identifier "$DB" \
      --query "DBInstance.DBInstanceStatus" --output text
    ;;
  available)
    echo "既に起動しているので start はしない"
    ;;
  stopping|deleting|failed|inaccessible-encryption-credentials)
    # ここから available にはならない。待っても30分無駄にするだけなので即やめる
    echo "NG: ${STATUS} からは available になりません。" >&2
    echo "    stopping なら stopped になってから流し直してください。" >&2
    echo "    それ以外は AWS コンソールで状態を確認してください。" >&2
    exit 1
    ;;
  *)
    # backing-up / modifying / rebooting / configuring-enhanced-monitoring など。
    # start は打てないが、放っておけば available に戻る
    echo "${STATUS}。start は打たず、available になるまで待つ"
    ;;
esac

# どの経路を通っても必ずここを通す(available でも、待ちが空振りするだけで害はない)
echo "== available になるまで待つ(停止からの起動なら数分) =="
aws rds wait db-instance-available --db-instance-identifier "$DB"
echo "RDS: available"

echo "== ECSサービスを1タスクに戻す =="
for svc in rag backend; do # backendはrag/DBに依存するので後
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
    --desired-count 1 --query "service.[serviceName,desiredCount]" --output text
done

echo "== backendがALBでhealthyになるまで待つ =="
TG=$(aws elbv2 describe-target-groups --names manual-search-backend \
  --query "TargetGroups[0].TargetGroupArn" --output text)
for i in $(seq 1 30); do
  N=$(aws elbv2 describe-target-health --target-group-arn "$TG" \
    --query "TargetHealthDescriptions[?TargetHealth.State=='healthy'] | length(@)" --output text)
  if [ "$N" -ge 1 ]; then
    echo "healthy。本番URL: https://d3r3bcg6d6aepn.cloudfront.net"
    exit 0
  fi
  echo "[$i/30] healthy待ち..."
  sleep 20
done
echo "healthyになりません。aws logs tail /ecs/manual-search/backend で確認してください" >&2
exit 1
