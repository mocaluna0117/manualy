# バックアップと監視

## バックアップ

| 対象 | 方法 | 保持 |
|---|---|---|
| DB(分類・チャット履歴・ルール・ユーザー) | RDS自動バックアップ | **1日**(下記の制限) |
| DB(任意の時点) | 手動スナップショット | 消すまで無期限 |
| PDF本体 | S3バージョニング | 旧版は90日で自動削除 |

### 保持期間が1日しかない理由

このAWSアカウントは無料プランのため、自動バックアップの保持期間を
1日から増やせない(2日でも `FreeTierRestrictionError` になる)。
そのため**重要な操作の前には手動スナップショット**を取る運用で補う。
手動スナップショットは保持期間の制限を受けず、削除するまで残る。

```sh
# 取得(再分類・一括再取り込み・マイグレーションの前に推奨)
aws rds create-db-snapshot \
  --db-instance-identifier manual-search-db \
  --db-snapshot-identifier "manual-search-db-manual-$(date +%Y%m%d-%H%M)"

# 一覧
aws rds describe-db-snapshots --db-instance-identifier manual-search-db \
  --query "DBSnapshots[].{id:DBSnapshotIdentifier,type:SnapshotType,created:SnapshotCreateTime}" --output table
```

会社アカウントへ移行したら `--backup-retention-period 14` に変更する
(プランの制限が外れるため)。

### その他の保護

- RDSの**削除保護**を有効化済み(インスタンスを直接削除できない)
- S3(manuals)は**バージョニング有効**。上書き・削除しても旧版から戻せる
  - ライフサイクル: `manuals-lifecycle.json`(旧版90日、未完了アップロード7日)

## 監視

通知先はSNSトピック `manual-search-alerts`(メール2件)。
アラーム定義は `cloudwatch-alarms.json`。

| アラーム | 意味 |
|---|---|
| backend-unhealthy | ALBのヘルスチェック失敗(検索できない) |
| backend-5xx | サーバーエラーが5分で5件超 |
| backend-stopped / rag-stopped | サービスのタスクが動いていない |
| db-low-storage | RDSの空き容量が2GB未満 |

`LiveTaskCount` は Container Insights 無しで取れる `AWS/ECS` の標準メトリクス。
Container Insights は追加コストがかかるため有効化していない。

**注意**: `scripts/aws-stop.sh` で意図的に停止すると `*-stopped` が発報する
(想定どおりの動作)。
