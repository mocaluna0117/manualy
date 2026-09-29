# R2（PDFの保管庫）の設定

AWS の S3 から移した先。`infra/s3/manuals-cors.json` の R2 版。

| 項目 | 値 |
| --- | --- |
| バケット | `manual-search-manuals` |
| 置き場所 | Asia-Pacific (APAC) — 利用者がブラウザから直接ダウンロードするため |
| ストレージクラス | Standard（Infrequent Access は無料枠の対象外） |
| S3エンドポイント | `https://<アカウントID>.r2.cloudflarestorage.com` |

## CORS（`manuals-cors.json`）

**入れ忘れるとアップロードが動かない。** ブラウザは署名付きURLで R2 へ
直接 PUT するので、R2 側が画面のオリジンを許可していないとブラウザが止める。
`ExposeHeaders: ETag` も要る（アップロード完了の確認に使う）。

アプリが使う鍵は `Object Read & Write` に絞ってあり、**バケットの設定は変えられない**
（一覧取得もバケット作成も拒否されることを確認済み）。そのため CORS は画面から入れる:

> R2 → `manual-search-manuals` → Settings → CORS Policy → Add CORS policy
> → `manuals-cors.json` の中身を貼る

Pages のURLが確定したら `https://manualy.pages.dev` の行を実際のURLに直す。
`http://localhost:5173` は手元の開発用なので残しておいてよい。

## 確認のしかた

```bash
set -a; . ./.env.migration; set +a
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
aws s3 ls "s3://$R2_BUCKET/" --endpoint-url "$R2_S3_ENDPOINT" --summarize | tail -3
```
