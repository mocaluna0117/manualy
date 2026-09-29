#!/usr/bin/env bash
# 無料クレジットの残りと、このままの使い方だと何日で尽きるかを表示する。
#
#   ./scripts/check-credits.sh
#
# クレジットが尽きた時点でアカウントは自動的に閉鎖され、リソースは止まり、
# データは90日後に完全に消える。移行の締切はこの日付で決まるので、
# 週に一度はこれを見て残り日数を把握する。
#
# 注: Cost Explorerの問い合わせは1回$0.01かかる。**このスクリプトで1回=$0.01。**
#     以前は日次の合計とサービス別の内訳で2回投げていたが、
#     日次をサービス別に割って取れば1回で両方まかなえる(投げるたびに課金される)。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Cost Explorer の End は **その日を含まない**。End=今日 にすると、
# 返ってくるのは「30日前〜昨日」の30日ぶんで、集計途中の当日は最初から入らない。
START="$(date -v-30d +%Y-%m-%d)"
END="$(date +%Y-%m-%d)"

# 無料プランの状態を扱うAPIはus-east-1にしかない
PLAN="$(aws freetier get-account-plan-state --region us-east-1 --output json)"

python3 - "$PLAN" "$(aws ce get-cost-and-usage \
  --time-period "Start=$START,End=$END" \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}' \
  --region us-east-1 --output json)" <<'PY'
import json, sys
from collections import defaultdict
from datetime import date, datetime, timedelta

plan, cost = (json.loads(a) for a in sys.argv[1:3])

remaining = float(plan["accountPlanRemainingCredits"]["amount"])
expires = plan["accountPlanExpirationDate"][:10]
status = plan["accountPlanStatus"]

if cost.get("NextPageToken"):
    print("!! 結果が途中で切れています(NextPageToken あり)。下の金額は全部過小です", file=sys.stderr)

# サービス別に割って取ると Total は空で返る。日ごとの合計は Groups を足して出す
days = []                        # [(日付, その日の合計)]
per_service = defaultdict(float)
for b in cost["ResultsByTime"]:
    total = 0.0
    for g in b["Groups"]:
        amt = float(g["Metrics"]["UnblendedCost"]["Amount"])
        total += amt
        per_service[g["Keys"][0]] += amt
    days.append((b["TimePeriod"]["Start"], total))

if not days:
    sys.exit("Cost Explorer から1日も返ってきませんでした")

today = date.today()
span = f"{days[0][0]} 〜 {days[-1][0]}"
spent = sum(c for _, c in days)

print(f"無料プランの状態 : {status}")
print(f"残りクレジット   : ${remaining:,.2f}")
print(f"集計期間         : {span}({len(days)}日ぶん)")
print(f"                   当日 {today:%Y-%m-%d} は集計途中なので入れていない")
last = datetime.strptime(days[-1][0], "%Y-%m-%d").date()
if last < today - timedelta(days=1):
    print(f"                   ※Cost Explorer の反映が {last} までしかない(通常は前日ぶんまで)")
print(f"この期間の消費   : ${spent:,.2f}")

# 直近7日のうち、実際に課金が出ている日だけで平均を出す
# (停止していた日を混ぜると枯渇日を楽観的に見誤る)
window = days[-7:]
recent = [(d, c) for d, c in window if c > 0.01]
per_day = sum(c for _, c in recent) / len(recent) if recent else 0.0

if per_day:
    print(f"1日あたり        : ${per_day:,.2f}  "
          f"({window[0][0]}〜{window[-1][0]} のうち課金のあった{len(recent)}日の平均)")
    print(f"1か月あたり      : ${per_day * 30:,.2f}")
    left = int(remaining / per_day)
    gone = today + timedelta(days=left)
    print()
    print(f"このままだと残り : 約{left}日 → {gone:%Y年%m月%d日} ごろ枯渇")
    limit = datetime.strptime(expires, "%Y-%m-%d").date()
    if limit < gone:
        print(f"                   ただしアカウント期限 {limit:%Y年%m月%d日} が先に来る")
    else:
        print(f"(アカウント期限は {limit:%Y年%m月%d日} なので、枯渇のほうが先)")
    print()
    if left <= 14:
        print("!! 残り2週間以内。移行を完了させるか、有料プランへの切替を決めること")
    elif left <= 45:
        print("!  移行作業に着手していること。scripts/backup-all.sh も定期的に")
else:
    print(f"{window[0][0]}〜{window[-1][0]} に課金がありません(停止中か、まだ集計されていません)")

print(f"\n内訳({span})")
for name, amt in sorted(per_service.items(), key=lambda kv: -kv[1]):
    if amt >= 0.01:
        print(f"  {amt:8.2f}  {name}")
PY
