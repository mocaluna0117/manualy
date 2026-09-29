# AWS本番デプロイ計画書

個人AWSアカウント（無料プラン・$200クレジット）への初回デプロイ計画。
将来の会社アカウント移行を見据え、手順・コスト・設計判断を記録する。

## 1. 全体アーキテクチャ

```
[ブラウザ]
   │ HTTPS (xxx.cloudfront.net)
   ▼
[CloudFront] ─── /* ────────▶ [S3: フロントバケット] Reactビルド成果物
   │
   └── /graphql ────────────▶ [ALB] ─▶ [ECS Fargate: backend]
                                            │
                                            ├─▶ [RDS PostgreSQL 16 + pgvector]
                                            ├─▶ [S3: manualsバケット] PDF本体
                                            └─▶ [ECS Fargate: rag] ─▶ [Bedrock]
                                                 (Titan Embeddings V2 / Claude Haiku jp.)
[Cognito User Pool] ← 既存のものを継続利用(コールバックURLにCloudFrontドメインを追加)
```

### なぜこの形か

| 判断 | 理由 |
| --- | --- |
| フロントは S3 + CloudFront | SPA配信の定番。月$1未満、HTTPS付き、コンテナ不要 |
| CloudFront が必須 | Cognitoのコールバックは localhost 以外 **HTTPS必須**。独自ドメイン無しでHTTPSを得る最も手軽な手段 |
| CloudFront を API の前にも置く | フロントとAPIが同一ドメインになり CORS 問題も消える。ALBは`*.cloudfront.net`の証明書を持てないため、CF→ALB間はHTTP(閉域) |
| ragサービスは非公開 | ALBに繋がず、backendからのみサービス間通信(Service Connect / 内部DNS)で到達 |
| RDSは非公開サブネット相当 | セキュリティグループで「backendとragのSGからの5432のみ許可」 |

## 2. フェーズ分割（1フェーズずつ検証しながら進める）

### フェーズ1: ECR（コンテナ置き場）
- ECRリポジトリを2つ作成: `manual-search/backend`, `manual-search/rag`
- ローカルでビルドしたイメージをタグ付けしてpush
- ビルドは **`--platform linux/arm64`**（下の進捗ログの決定を参照）
- コスト: ~$0.1/GB/月。ほぼ無料

### フェーズ2: S3バケット
- `manuals`用バケット（PDF本体。非公開・presigned URLでのみアクセス）
  - CORS設定: CloudFrontドメインからのPUT/GETを許可（ブラウザ直アップロードのため）
- フロント配信用バケット（CloudFront経由でのみ公開: OAC設定）
- コスト: ほぼ無料

### フェーズ3: RDS（PostgreSQL + pgvector）
- db.t4g.micro / gp3 20GB / PostgreSQL 16
- パスワードは Secrets Manager に保存（環境変数直書きしない）
- セキュリティグループ: ECSタスクのSGからのみ 5432 を許可
- 初期化: `CREATE EXTENSION vector` → `prisma migrate deploy`（ECSの一時タスク or ローカルから踏み台的に実行）
- コスト: **~$21/月（最大の固定費その1）**

### フェーズ4: ECS Fargate（backend + rag）
- クラスター作成 → タスク定義2つ → サービス2つ
- **タスクロール**（重要な学び）: S3・Bedrockへの権限はIAMロールで付与。
  アクセスキーをコンテナに入れない。ローカルの`~/.aws`マウントは本番では不要になる
- 環境変数のうち秘密のもの（DATABASE_URL等）は Secrets Manager 参照で注入
- ログは CloudWatch Logs へ（`awslogs`ドライバ）
- ALB: ターゲットグループ(backend:3000) + ヘルスチェック(`/graphql`はPOSTなので、`@Public`なhealthを叩けるGET経路 or ALBヘルスチェック用の軽いHTTPエンドポイントを用意)
- コスト: Fargate×2 ~$22/月 + **ALB ~$18/月（固定費その2）**

### フェーズ5: フロント配信 + Cognito更新
- `./scripts/deploy-frontend.sh`（ビルド→検証→アップロード→無効化まで一括）。
  手で`npm run build`＋`aws s3 sync`しないこと。ローカル用の`.env`のまま
  ビルドして本番へ上げる事故と、Cache-Controlが外れる事故を実際に起こした
- CloudFront: オリジン2つ（S3 + ALB）、`/graphql`だけALBへルーティング
- SPAフォールバック: 403/404 → `/index.html`（nginx.confのtry_filesと同じ役割）
- Cognitoアプリクライアントのコールバック/ログアウトURLに `https://xxx.cloudfront.net` を追加
- 招待メールの文面(2026-08-18に日本語化): `infra/cognito/invite-message.json` を
  `update-user-pool --admin-create-user-config` で適用する。本文には `{username}` と
  `{####}` が必須。HTMLタグが使える
  - ⚠️ **`update-user-pool` は渡さなかった設定を既定値に戻す**。パスワードポリシー・
    MFA・自動検証属性・ティア・削除保護なども毎回一緒に渡すこと。
    適用後は describe-user-pool の前後を突き合わせて、意図しない差分が無いか確認する
  - 招待メールが迷惑メールに入る問題は文面では直らない。差出人が
    Cognito既定の共有アドレス(no-reply@verificationemail.com)であることが原因。
    直すには **SESの本番アクセス申請**(サンドボックス中は未認証の宛先に送れないので、
    先に申請が必須) → **自社ドメインをSESに登録してDKIMを設定** →
    `--email-configuration EmailSendingAccount=DEVELOPER` に切り替える、の順
- ログイン画面の日本語化(2026-08-16に実施):
  - 旧来のHosted UI(`ManagedLoginVersion: 1`)は英語のみで、Accept-Languageにも
    `ui_locales`にも反応しない(実測で確認)
  - 新しいmanaged login(`2`)に切り替え、認可リクエストに `lang=ja` を付けると日本語になる。
    Essentialsプラン以上 + ブランディングの作成が条件
  - **切り替えの順番が重要**: 先に `create-managed-login-branding` を実行してから
    `update-user-pool-domain --managed-login-version 2` を行う。逆にすると
    ログイン画面が「Login pages unavailable」になる(切り替え直後の伝播中に実際に出た)
  - 戻す場合は `--managed-login-version 1`
- backendの `FRONTEND_ORIGIN` をCloudFrontドメインに設定

### フェーズ6: E2E検証 + 運用スクリプト
- 本番URLでログイン→アップロード→取り込み→AI検索→履歴の全動線を確認
- 停止/再開スクリプト（節約用）:
  - 停止: ECSサービスのdesiredCount=0 + RDS停止（※RDSの停止は7日で自動再開される仕様に注意）
  - 再開: 逆の操作
- 完全撤収(teardown)手順も記録しておく

## 3. コスト（東京リージョン・概算）

| リソース | 常時起動 | 停止中 |
| --- | --- | --- |
| RDS db.t4g.micro + 20GB | ~$21/月 | ~$2/月(ストレージのみ) |
| Fargate ×2 (0.25vCPU/0.5GB) | ~$22/月 | $0 (desiredCount=0) |
| ALB | ~$18/月 | ~$18/月(削除しない限り発生) |
| CloudFront/S3/ECR/Cognito/Bedrock | ~$2/月 | ~$1/月 |
| **合計** | **~$63/月** | **~$21/月** |

- $200クレジット → 常時起動で約3ヶ月、こまめに停止すれば6ヶ月(アカウント期限)まで持つ
- ALBが「止められない固定費」なので、長期休止するならALBだけ削除→再作成が有効

## テスト

壊れると痛いところだけ、リポジトリに残してある。まとめて回すには:

```
./scripts/test.sh
```

- **バックエンド(jest)**: 問い合わせメールの組み立て(MIME・件名の符号化・
  添付の区切り・Reply-Toを付けてよいかの判定)。ここは壊れても例外が出ず
  「送ったのに届かない」形で表面化するため
- **RAG(pytest)**: 検索結果の融合(RRF)、質問に添えた画像の受け渡し、
  「答えられたか」の判定、LLM出力の解析([選択肢]/[参照])。
  Pythonの依存を手元に入れずに済むよう、本番と同じイメージの中で動かす

画面(React)のテストは無い。入れるなら試験用の実行環境を足すところから。

## 4. セキュリティ設計の要点

- **公開されるのはCloudFrontだけ**。ALBはCloudFrontからのみ、RDS/ragは内部からのみ
- ECSタスクロールに最小権限（S3の対象バケットのみ / bedrockは呼ぶモデルのみ）
  - 回答のストリーミング(converse_stream)には `bedrock:InvokeModelWithResponseStream` が別途必要。
    `InvokeModel` があっても許可されず、AccessDeniedExceptionになる（2026-08-16に踏んだ）。
    埋め込み(Titan)はストリーミングしないので対象外。定義は infra/iam/rag-task.json
  - 問い合わせメールに添付を付けると、SESの呼び出しがSimple形式からRaw形式に変わり、
    IAM上は `ses:SendRawEmail` という別のアクションになる。`ses:SendEmail` だけだと
    「is not authorized to perform ses:SendRawEmail」で送信が失敗する（2026-08-16に踏んだ）。
    添付の有無で必要な権限が変わるため両方を許可する。定義は infra/iam/backend-task-ses.json
    - 失敗しても問い合わせ自体はDBに残る作りなので、権限を直せば内容は追える
- 秘密情報は Secrets Manager（DBパスワード、必要ならCognito設定）
- ⚠️ 個人アカウントの間は**ダミーPDFのみ**。実マニュアルは会社アカウント移行後

## 5. 会社アカウント移行時にやること（差分）

1. 本計画のフェーズ1〜6を会社アカウントで再実行（手順はこのリポジトリのチャット/ドキュメントに記録済み）
2. Cognitoに **Microsoft Entra ID をフェデレーション**（「Microsoftでサインイン」ボタン）
3. 独自ドメイン + ACM証明書（`manuals.会社ドメイン` など）
4. 実マニュアル投入・管理者ロールの割当ルール決定
5. （推奨）ここまでのCLI手順を IaC（Terraform / CDK）に書き起こして再現性を確保

## 進捗ログ

### ✅ フェーズ1: ECR(完了 2026-07-28)

作成したもの:

- ECRリポジトリ 2つ(東京リージョン)
  - `271357390238.dkr.ecr.ap-northeast-1.amazonaws.com/manual-search/backend`
  - `271357390238.dkr.ecr.ap-northeast-1.amazonaws.com/manual-search/rag`
- push時の脆弱性スキャン有効、ライフサイクルポリシー(直近5世代のみ保持)
- 予算アラート `free-credit-usage`: $200上限・50/75/90%でメール通知
  - **`IncludeCredit: false` が重要**。既定(true)だとクレジットで相殺された分が
    $0として扱われ、クレジットの消費を検知できない

**決定: Fargateは ARM64(Graviton) を使う**

| 理由 | 内容 |
| --- | --- |
| コスト | x86_64より約20%安い。無料クレジットが長持ちする |
| ビルド速度 | 開発機がApple Silicon(arm64)なのでエミュレーション無しでネイティブビルドできる |
| 対応状況 | ベースイメージ(node:24-slim / python:3.13-slim / nginx:alpine)は全てarm64対応。
  依存(pypdfium2, pillow, psycopg[binary])もarm64ホイールあり |

→ フェーズ4のタスク定義で `runtimePlatform.cpuArchitecture: ARM64` を指定すること。
   イメージのビルドは `docker build --platform linux/arm64` で行う。

pushしたイメージ(圧縮後): backend 287.5MB / rag 95.6MB
ECRのストレージ代は $0.10/GB/月 なので月$0.04程度。

### ✅ フェーズ2: S3バケット(完了 2026-07-28)

作成したもの(東京リージョン):

- `manual-search-manuals-271357390238` … PDF本体。署名付きURLでのみアクセス
- `manual-search-frontend-271357390238` … フロントのビルド成果物。CloudFront(OAC)経由でのみ公開

両バケットに設定したもの:

- 公開アクセスを4項目すべてブロック(BlockPublicAcls / IgnorePublicAcls / BlockPublicPolicy / RestrictPublicBuckets)
- 保管時暗号化 SSE-S3(AES256) + BucketKeyEnabled
- 検証: 匿名GETは403、認証ありのアップロードは成功

**CORSはフェーズ5で設定する**。ブラウザからの直接アップロードを許可する
オリジンがCloudFrontのドメインで、その値がフェーズ5まで確定しないため。
(フロントを配信するまでアップロードは使わないので順序上問題ない)

### ✅ フェーズ3: RDS(完了 2026-07-28) ← ここから固定費が発生

作成したもの:

| 種別 | 値 |
| --- | --- |
| DBインスタンス | `manual-search-db` / PostgreSQL **16.14** / **db.t4g.micro**(Graviton) |
| ストレージ | gp3 20GB・保管時暗号化あり |
| エンドポイント | `manual-search-db.cl648g46m6kn.ap-northeast-1.rds.amazonaws.com:5432` |
| 認証情報 | **Secrets Manager** `manual-search/db`(環境変数に直書きしない) |
| ネットワーク | デフォルトVPC・サブネットグループ`manual-search-subnets`(3AZ) |
| セキュリティグループ | `manual-search-rds`(sg-0ce62d9c267cad40b) |
| ECSタスク用SG | `manual-search-ecs`(sg-058aea10195085c48) ← フェーズ4で使う |

**検証済み:**

- pgvector **0.8.2** / pg_trgm 1.6 が有効(ローカルと同じバージョン)
- `prisma migrate deploy` で全マイグレーション適用済み。テーブル6つ + _prisma_migrations
- **HNSWインデックスとGIN(trgm)インデックスが正しく作成されている**
  (RDSでHNSWが使えるかは事前にバージョンを確認: pgvector 0.8.0はPG16.5以降で提供)

**学び: 無料プランにはリソース制限もある**

クレジット上限だけでなく、リソースの構成にも制限がかかる。
バックアップ保持期間を7日で作成しようとしたら `FreeTierRestrictionError` で拒否され、
1日に下げて作成した。

→ 対策(2026-08-16): **AWS Backupで日次スナップショットを別枠で取る**。RDSの
自動バックアップ(1日)とは別の仕組みなので無料枠の制限を受けない。
保持は14日で、期限が来たものは自動で消える(手動スナップショットのように溜まらない)。

| 項目 | 値 |
|---|---|
| プラン | `manual-search-daily` (`infra/backup/backup-plan.json`) |
| 実行 | 毎日 18:00 UTC = 翌03:00 JST |
| 保管先 | Vault `manual-search` / 保持14日 |
| ロール | `manual-search-backup` (`infra/backup/backup-trust.json`) |
| 失敗時 | SNS `manual-search-alerts` へ通知(BACKUP_JOB_FAILED / EXPIRED) |

設定した直後に手動で1回実行し、復旧ポイントができて期限が14日後に
設定されることまで確認してある。設定だけして「動いているつもり」に
しないこと。会社アカウント(有料プラン)へ移行する際は、
保持期間やマルチAZなどを本番向けに見直す必要がある。

**⚠️ 未処理の設定(フェーズ6で必ず閉じる)**

デバッグとマイグレーションのため、現在RDSは以下の状態にしている:

- `publicly-accessible: true`
- セキュリティグループで **開発機のIP(114.146.77.12/32)からの5432のみ** 許可

実際の防御はSGの1IP制限 + 48文字のパスワード + TLSだが、IPは変わるので
フェーズ6の最後に「自分のIPのルール削除」と`--no-publicly-accessible`への変更を行う。

### ✅ フェーズ4: ECS Fargate + ALB(完了 2026-08-04)

作成したもの(構成ファイルは `infra/` に保存。会社アカウント移行時に再利用する):

| 種別 | 値 |
| --- | --- |
| クラスター | `manual-search`(Service Connect名前空間 `manual-search` を既定に設定) |
| サービス | `backend`(ALB配下・1タスク) / `rag`(非公開・1タスク) |
| タスク定義 | backend 0.25vCPU/512MB、rag 0.5vCPU/1GB、migrate 0.25vCPU/512MB。全てARM64 |
| ALB | `manual-search-alb-1421816805.ap-northeast-1.elb.amazonaws.com` |
| ヘルスチェック | `GET /healthz`(30秒間隔・2回連続成功でhealthy) |
| ログ | `/ecs/manual-search/{backend,rag}`(保持7日) |
| シークレット | `manual-search/app`(DATABASE_URL / RAG_API_TOKEN) |
| IAMロール | 実行ロール1つ + タスクロール2つ(下記) |

**IAMは「ECSの権限」と「アプリの権限」を分ける**

- `manual-search-ecs-execution`(実行ロール) … ECRからpull・ログ出力・シークレット注入
- `manual-search-backend-task` … S3の`manuals`バケットのオブジェクトのみ
- `manual-search-rag-task` … Bedrockの2モデルのみ(S3権限は**不要**。PDFは
  backendが発行した署名付きURLで取得するため)

アクセスキーはどこにも置いていない。`storage/service.ts`が「キーが設定されている
ときだけcredentialsを渡す」実装になっているので、ECS上では自動的にタスクロールが使われる。

**メモリはローカルで実測して決めた**

推測でFargateのメモリを決めるとOOMの調査で時間を失う。実測値:
アイドル時 backend 158MB / rag 99MB、PDF30ページの画像化のピークでも+20MB程度
(測定時のピーク302MBの大半はテストPDFの生成側だった)。
→ backend 512MB / rag 1GB で十分な余裕があると判断。

**NAT Gatewayを使わない構成にした**

デフォルトVPCのサブネットは全てパブリックなので、`assignPublicIp=ENABLED`で
ECR/Bedrock/S3へ直接出る。NAT Gatewayを置くと月$33でALBより高くつく。
タスクにパブリックIPは付くが、受信はセキュリティグループで塞いでいる
(ALBからの3000のみ / rag宛8000は同一SG内のみ)。

**ALBはCloudFront経由のみに絞った**

AWS管理のプレフィックスリスト `com.amazonaws.global.cloudfront.origin-facing`
を使うと、CloudFrontのIP範囲を自分で管理せずに済む(無料)。

### 学び1: ALBのヘルスチェックには専用の公開エンドポイントが必要

雛形の`GET /hello`は**401**を返した。グローバル認証ガード(`APP_GUARD`)はREST経路にも
適用されるため。これをヘルスチェックに使うとALBが全タスクを異常判定し続ける。

`@Public()`付きの`GET /healthz`を追加し、**DBやRAGは意図的に見ない**ようにした。
依存先の障害でヘルスチェックを落とすと、ECSがタスクを次々に入れ替えるだけで
復旧しない(DBが落ちているのはタスクの責任ではない)。

E2Eテストも本番と同じくグローバルガードを有効にした状態で検証している。

### 学び2: RDSのTLS証明書はNodeの標準信頼ストアに無い

最初のデプロイは `P1011 TlsConnectionError: self-signed certificate in certificate chain`
で起動できなかった。RDSの証明書はAmazon独自のCAで署名されているため。

さらに厄介だったのが、**CAを渡しても効かなかった**こと。原因は
`pg`が接続文字列を後から解釈して`ssl`設定を上書きすること。
`sslmode=require`が残っていると`ssl:{}`に差し替えられ、渡したCAが捨てられる
(pgは`require`を`verify-full`相当として扱うため、CA無しでは必ず失敗する)。

対処:

- CAはイメージのビルド時に取得(ベースイメージのnode/python自身でダウンロード。
  リポジトリに証明書ファイルを置かない)
- backend: `sslmode`をURLから除去し、`ssl:{ca, rejectUnauthorized:true}`だけを効かせる
- rag(psycopg): `sslmode=verify-full` + `sslrootcert`をkwargsで指定
  (psycopgの`require`は「暗号化するが相手を確認しない」なので不十分)

`rejectUnauthorized:false`にすれば通るが、それでは中間者攻撃を検知できないため採用しない。

**ECRにpushする前に実RDSに対して検証した**(1往復10分の無駄を避けるため):
sslmode残す→再現、sslmode除去+CA→成功、**空のCA→失敗**(検証が実際に
行われていることの対照実験)。

### 検証結果: 本番環境で全経路が動作することを確認

検証用の一時ユーザーとテストPDFで一通り流し、**終了後に全て削除済み**(DBは空):

| 経路 | 結果 |
| --- | --- |
| ALB → backend `/healthz` | 200 |
| 未認証のGraphQL | Unauthorized(認証が効いている) |
| Cognito認証 → JWT検証 → 利用者の自動登録 | User行が自動生成された |
| backend → RDS(証明書検証付きTLS) | 読み書き成功 |
| backend → rag(Service Connect `http://rag:8000`) | `ragHealth: ok` |
| タスクロールでのS3署名付きURL発行 | 成功(ホストがSSRF許可リストと一致) |
| ブラウザ相当のS3への直接アップロード | 200・SSE-S3で暗号化 |
| rag → S3ダウンロード → Bedrock埋め込み → pgvector保存 | 2チャンク取り込み成功 |
| ハイブリッド検索 → Claude Haiku(jp.プロファイル)で回答 | 正しい電話番号を引用付きで回答 |

### ✅ フェーズ5: フロント配信 + Cognito更新(完了 2026-08-05)

**本番URL: https://d3r3bcg6d6aepn.cloudfront.net**

作成したもの(構成は `infra/cloudfront/` `infra/s3/` に保存):

| 種別 | 値 |
| --- | --- |
| ディストリビューション | `E1RJTGF8IYA944` / `d3r3bcg6d6aepn.cloudfront.net` |
| OAC | `E3BSJZTFX2HJQN`(S3はこのCloudFrontからのGETのみ許可) |
| オリジン | S3(フロント) + ALB(`/graphql`のみ・HTTP閉域) |
| SPAフォールバック | 403/404 → `/index.html`(200) |
| セキュリティヘッダ | マネージドの`SecurityHeadersPolicy`(HSTS等) |

**設計のポイント**

- フロントは `VITE_GRAPHQL_URL=/graphql`(相対パス)でビルドした。
  CloudFrontがフロントとAPIを同一オリジンにまとめるので、**CORSがそもそも発生しない**。
  `redirect_uri`も`window.location.origin`から自動決定なので、
  CloudFrontのドメインが確定する前にビルドできた
- キャッシュは役割で分ける:
  - `index.html` → `no-cache`(JSのファイル名が変わっても古いHTMLを掴まないように)
  - `assets/*` → `max-age=31536000, immutable`(ファイル名にハッシュが入るため安全)
- `/graphql`ビヘイビアは `CachingDisabled` + `AllViewerExceptHostHeader`。
  Hostヘッダを転送から除くのが定石(オリジンに`*.cloudfront.net`のHostが渡ると
  ホスト名ベースの検証・ルーティングを持つオリジンで事故る)
- マネージドポリシーのIDは推測せずCLIで実際に引いた(`list-cache-policies`等)
- PDFバケットのCORSは`https://d3r3bcg6d6aepn.cloudfront.net`のみ許可
  (署名付きURLでのブラウザ直PUT/GETに必要)
- Cognitoのコールバック/ログアウトURLにCloudFrontドメインを追加。
  あわせて`ALLOW_USER_PASSWORD_AUTH`を無効化した(検証で一時的に使っただけ。
  本番はホストUI+PKCEのみにして総当たり攻撃の入口を減らす)
- backendの`FRONTEND_ORIGIN`をCloudFrontドメインに更新(タスク定義 rev3)

**検証済み**

| 経路 | 結果 |
| --- | --- |
| HTTP → HTTPSリダイレクト | 301 |
| SPA配信 + 存在しないパス(`/manuals`) | どちらも200でindex.html |
| assets のキャッシュヘッダ + HSTS | 設定どおり |
| `/graphql` → CloudFront → ALB → backend | `health: ok` |
| Authorizationヘッダの転送 | 壊れたトークンでUnauthorized(=転送されている) |
| CognitoホストUIが`redirect_uri`を受理 | 302→/login。未登録URIだと`redirect_mismatch`(対照実験) |

### ✅ フェーズ6: E2E検証 + 締めの設定 + 運用スクリプト(完了 2026-08-05)

**これで全フェーズ完了。本番URL: https://d3r3bcg6d6aepn.cloudfront.net**

**ブラウザE2E(ヘッドレスChrome + CDPで自動化)**

一時ユーザーで本番URLの実ブラウザ動線を検証し、終了後に削除した(DBは空のまま):

1. SPAのログイン画面が表示される
2. ログインボタン → CognitoホストUIへ遷移
3. 認証情報を送信 → CloudFrontへ戻る → 認可コード交換
4. アプリ本体が描画される(サイドバー・チャット欄・ユーザー表示をスクリーンショットで確認)

**締めの設定(デバッグ用に開けていた入口を全て閉じた)**

| 変更 | 対照実験 |
| --- | --- |
| RDSのSGから開発機IPのルールを削除 | — |
| RDS `--no-publicly-accessible`(DNSも私有IPを指す) | ローカルからの5432接続がタイムアウト |
| ALBのSGから開発機IPの一時ルールを削除 | ALB直アクセスがタイムアウト。CloudFront経由は200 |

非公開化後にbackendを強制再デプロイし、新タスクが起動時のDBアクセス
(bootstrap処理)を通ってhealthyになることを確認 → **ECSからの新規DB接続も問題なし**。

なお `/healthz` をCloudFrontで叩くとSPAが返るのは正しい挙動
(ALBへ行くのは`/graphql`だけ。ヘルスチェックはALB→ターゲットの直接経路で使われる)。

**運用スクリプト**

- `scripts/aws-stop.sh` … Fargate 0タスク + RDS停止(約$84/月 → **約$31/月**)。
  止めても残るのは ALB $17.46/月・公開IPv4×2 $7.20/月・RDSのバックアップとストレージ $5.70/月・
  Secrets $0.90/月 など(2026-09-10 に Cost Explorer で実測。**約$1.05/日**)。
  以前ここに書いていた「約$21/月」は低すぎた。
  RDS停止は**7日で自動再開**されるAWS仕様に注意
- `scripts/aws-start.sh` … RDS起動を待ってからECSを戻し、healthyまで見届ける

## 8. 完全撤収(teardown)手順

課金を完全に止める場合。**順序が大事**(依存の外側から):

1. CloudFront: ディストリビューションを**無効化 → Deployed待ち → 削除**(無効化を挟まないと削除できない)
2. ALB → ターゲットグループの順に削除(ALBが参照している間はTGを消せない)
3. ECS: サービス2つを`desired-count 0` → 削除 → クラスター削除
4. RDS: 最終スナップショットを取って削除(`--final-db-snapshot-identifier`)。
   完全に捨てるなら`--skip-final-snapshot`
5. S3: 2バケットを**空にしてから**削除(`aws s3 rm --recursive` → `delete-bucket`)
6. ECR: リポジトリ2つを`--force`で削除(イメージごと)
7. Secrets Manager: `manual-search/db` `manual-search/app` を削除
   (既定で30日の復旧猶予。即時なら`--force-delete-without-recovery`)
8. CloudWatch Logs: `/ecs/manual-search/*` を削除
9. IAMロール3つ + インラインポリシー、セキュリティグループ3つを削除
10. Cognito User Pool: 残してもほぼ無料。捨てるならドメイン → プールの順

Cognitoとの紐付け(コールバックURL)やCLI手順は全てこの計画書と
`infra/`に残っているので、会社アカウントでの再構築はフェーズ1から再実行すればよい。

## 6. 未決事項

- [x] 運用モード → 無料クレジット内(約3ヶ月)のお試しとして常時起動。クレジット消尽でアカウントが自動閉鎖されるため、10月末が実質の期限
- [ ] 会社AWSアカウントへの移行(本番として継続するなら必須)
- [x] ALBヘルスチェック用エンドポイント → `@Public()`な`GET /healthz`(生存確認のみ)
- [x] backend→rag間のサービスディスカバリ → ECS Service Connect。
      クラスターの既定名前空間を`manual-search`にし、`http://rag:8000`で到達できる
      (ローカルのcompose設定と同じ値のまま動く)

## 7. 運用メモ

**マイグレーションの流し方(フェーズ6でRDSを非公開に戻した後)**

`manual-search-migrate`タスク定義を単発実行する。実行イメージには
マイグレーションのSQLが入っていないため(runtimeステージは`dist`しか
コピーしない)、Dockerfileのbuildステージを`backend:migrate`タグとして
pushしてある。**新しいマイグレーションを足したら、このタグも一緒に
push し直すこと。** 忘れると、タスクは古いマイグレーションしか持たない。

```
docker build --platform linux/arm64 --target build \
  -t <ECR>/manual-search/backend:migrate -f backend/Dockerfile backend
docker push <ECR>/manual-search/backend:migrate
```

```
aws ecs run-task --cluster manual-search --task-definition manual-search-migrate \
  --launch-type FARGATE --network-configuration \
  "awsvpcConfiguration={subnets=[subnet-0725bfdde0b078c0b],securityGroups=[sg-058aea10195085c48],assignPublicIp=ENABLED}"
```

**マイグレーションを手で流す場合(2026-08-16に実施)**

列を1つ足すだけなら、実行中のbackendイメージから直接流したほうが速い。
`backend:migrate`のpushを忘れていても実行できる。手順は次の3つ。

1. **先にRDSのスナップショットを取る**
   (`aws rds create-db-snapshot`。`available`になるまで待つ)
2. `manual-search-backend`タスク定義を単発実行し、コマンド上書きで
   `node -e` からPrismaクライアント経由でSQLを流す。接続の作り方は
   `src/prisma/service.ts` と同じ(`PrismaPg` + RDSのCA)にする
3. 同じ実行の中で`_prisma_migrations`に記録を1行入れる。入れないと
   次回の`migrate deploy`が「未適用」と誤認して二重に流そうとする。
   checksumは**migration.sqlのsha256**で、ローカルで適用済みなら
   `SELECT checksum FROM _prisma_migrations WHERE migration_name=...`
   でそのまま取れる(`shasum -a 256`の結果と一致する)

流したあとは`pg_indexes`を数えて、生SQLで作った検索用インデックス
(HNSW / pg_trgm)が残っていることを必ず確認する。

**管理者(ADMIN)ユーザーの用意**

ログインはJITプロビジョニングで自動登録されるが、ロールは既定で`MEMBER`。
ADMINにするには`User`テーブルの行を直接更新する。RDSは非公開なので、
migrateタスクにコマンド上書きでSQLを流す(2026-08-05に実施済みの手順):

- Cognitoのユーザーのsubを控える(`list-users`)
- `containerOverrides`で `npx prisma db execute --stdin` にSQLをheredocで渡す
  - `INSERT ... ON CONFLICT (cognito_sub) DO UPDATE SET role='ADMIN'` の形にすると
    ログイン前(行なし)でもログイン後(行あり)でも同じコマンドで済む
  - JITは`cognitoSub`で照合するので、事前に入れた行が初回ログインでそのまま使われる
- 注意(実際に踏んだ):
  - **Prisma 7では`db execute`の`--url`が廃止**。接続先は`prisma.config.ts`が
    読む`DATABASE_URL`環境変数(タスク定義がシークレットとして注入)に任せる
  - シェルに`set -e`を入れる。無いと失敗してもexit 0になり成功に見える

**コンテナに入って調べる(ECS Exec)**

タスクロールに`ecs-exec`ポリシーを付与し、backendサービスで有効化済み。
利用には`session-manager-plugin`のインストールが必要(sudoが必要なため未導入)。

```
aws ecs execute-command --cluster manual-search --task <ARN> \
  --container backend --interactive --command "/bin/sh"
```
