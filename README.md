# Manualy — 社内マニュアル検索システム

社内マニュアルが増えるほど「どれを見ればいいか分からない」状態になる。
このアプリは、**知りたいことを日本語で聞けば、根拠のマニュアルごと答えが返る**ようにする。

とある企業の社内での利用を前提に作っている。
機密資料を扱うため、ログインしないと何も見えない（招待制・Supabase Auth）。

```text
利用者:「トイレの漏水はどう対応する？」
  ↓
AI:「まず止水栓を閉めるよう案内します。止水後はお湯も止まることを伝えてください…」
    📄 社内用マニュアル（トイレ漏水対応フロー） p.4 受付時の対応
```

> **2026-09-12 に AWS から無料構成へ移った。**いまの本番は Cloudflare Pages + Cloud Run +
> Supabase + Cloudflare R2 + Workers AI で、**月額0円**で動いている。
> AWS 時代の構成は [docs/deployment-plan.md](docs/deployment-plan.md) に記録として残してある。

---

## 何ができるか

### 探す

- **AI検索（RAG）** — 日本語の質問に、マニュアルの記述だけを根拠に答える。回答は生成されるそばから流れて出る
- **根拠の提示** — 回答の下に、使ったマニュアルとページが並ぶ。押すとその場でPDFが開く
- **聞き返し** — 質問が曖昧なときは選択肢を出して絞り込む
- **画像を添えて質問** — 画面のスクリーンショットを4枚まで。貼り付け（Ctrl+V）でも添えられる
- **キーワード検索** — タイトル・ファイル名・本文の部分一致（AI検索とは別経路）

### 貯める

- **アップロード** — PDF / Word / Excel / PowerPoint / Outlookメール(.msg)。中身を読み取って検索対象にする
- **スキャンPDFの書き起こし** — 文字が取れないページは画像認識モデルでテキスト化する（最大60ページ）
- **AIによる自動分類** — 取り込み時とまとめての再分類。「床暖房関連はフローリングへ」のような分類ルールを覚えさせられる。再分類は元に戻せる
- **フォルダ管理** — 作成・名前変更・並べ替え・ゴミ箱（30日間は元に戻せる）
- **管理者だけに見せるフォルダ** — 人事や取引条件など。一覧にも検索にも出さず、**AIの回答の根拠にも使わない**（管理者の質問でも使わない）。AIの分類の行き先としては使える

### 育てる

- **利用状況（管理者のみ）** — 答えられなかった質問 / よく聞かれること / マニュアルの使われ方
- **回答への 👍 / 👎** — 人の判断をAIの自己申告より優先して集計する
- **マニュアルの下書き生成** — 答えられなかった質問から、章立てと分かっている範囲をAIが書く。分からないことは「(要確認)」で空ける
- **お問い合わせ** — 利用者からの要望・不具合報告をアプリ内で受け付け、管理者が一覧で見る

### チャットからの管理操作（管理者のみ）

会話の中でそのまま指示できる。

```text
「ANDPADというフォルダを作って、鍵付きにして」
「福祉住環境関係フォルダの名前を福祉住環境コーディネーターに変えて」
「床鳴りのマニュアルをフローリング関連に移して」
「全マニュアルを再分類して」          ← 実行前に確認が入る
「経理関係フォルダを削除して」        ← ゴミ箱へ（元に戻せる）
```

---

## 構成

```text
            ┌───────────────────────┐
 ブラウザ ──│ Cloudflare Pages      │  フロント(静的ファイル・PWA)
   │        └───────────────────────┘
   │ GraphQL / SSE(/chat/stream)  ※Authorization: Bearer <Supabase のJWT>
   ▼
 ┌──────────────────────┐  RAG_API_TOKEN   ┌──────────────────────┐
 │ backend (Cloud Run)  │ ───────────────▶ │ rag (Cloud Run)      │
 │ NestJS / GraphQL     │                  │ FastAPI              │
 │ 認証・権限・履歴      │ ◀─ Cloud Tasks ─┐ │ 検索・生成・取り込み  │
 └──┬─────────┬─────────┘  (取り込み/再分類) └──┬──────────┬───────┘
    │         │                                │          │
    ▼         ▼                                ▼          ▼
 ┌────────┐ ┌──────────────┐          ┌──────────────┐ ┌─────────────┐
 │Supabase│ │ Cloudflare R2│          │ Supabase     │ │ Workers AI  │
 │Postgres│ │ PDF等の原本   │          │ pgvector     │ │ 埋め込み・生成│
 │+ Auth  │ └──────────────┘          └──────────────┘ └─────────────┘
 └────────┘
```

- **フロントとAPIは別オリジン**。backend の CORS は `FRONTEND_ORIGIN`（本番は `https://manualy.pages.dev`）だけを許可する
- **ブラウザからRAGは叩かせない**。認証・権限・履歴の保存はすべて NestJS 側で行う。rag は Cloud Run 上で公開URLを持つが、
  共有トークン `RAG_API_TOKEN` が無いと全部 401、トークン未設定なら全部 503 にする（fail-closed）
- **取り込みと再分類は Cloud Tasks に積む**。Cloud Run はリクエストを返した後の処理が保証されないため、
  時間のかかる処理は backend の `/internal/*` を Cloud Tasks から呼び直す形にしている（`INGEST_INTERNAL_TOKEN` で保護）。
  ローカルでは `INGEST_DISPATCH=inline` でその場で実行する
- **回答はSSEで流す**。GraphQLは1往復で完成品を返す作りなので、ストリーミングだけ別経路（`/chat/stream`）にしている
- **ファイルの中身は backend を通らない**。アップロードもダウンロードも R2 の署名付きURLをブラウザに直接渡す

### 技術スタック

| 領域 | 採用 | 補足 |
| --- | --- | --- |
| フロント | React 19 + TypeScript + Vite + Chakra UI v3 | Apollo Client 4 / PWA |
| バックエンド | NestJS + GraphQL（コードファースト） | Prisma 7 |
| RAG | Python + FastAPI | 検索・生成・取り込み・分類を担当。DBは共有 |
| DB | PostgreSQL 16 + pgvector（Supabase・米国オレゴン） | HNSW索引 + pg_trgm |
| LLM | Cloudflare Workers AI（`@cf/google/gemma-4-26b-a4b-it`） | 回答・分類・画像認識・下書き・管理操作のツール呼び出し |
| 埋め込み | Workers AI（`@cf/baai/bge-m3`・1024次元） | 多言語対応。日本語の質問で英語資料も引ける |
| 認証 | Supabase Auth（メール + パスワード・招待制） | ロールはDBで管理（ADMIN / MEMBER） |
| 実行環境 | Cloud Run（us-west1）/ Cloud Tasks / Cloudflare Pages / Cloudflare R2 | すべて無料枠内 |

LLM・埋め込み・認証・ストレージはすべて環境変数で差し替えられる
（`EMBEDDING_PROVIDER=hashing|bedrock|workers_ai` / `ANSWER_PROVIDER=stub|bedrock|workers_ai` /
`AUTH_PROVIDER=supabase`（未設定なら Cognito）/ S3互換ならどこでも）。AWS から移ったときも、アプリのコードの差し替えは
この切り替え口を足すところまでで済んだ。

### 検索の仕組み

質問はまず**同義語込みのキーワード列に展開**してから、3つのルートで探す。

| ルート | 得意 |
| --- | --- |
| ベクトル | 意味の近さ。言い回しが違っても拾える |
| キーワード（ILIKE） | 型番・電話番号・固有名詞のような文字通りの一致 |
| タイトル | 本文に手がかりが無い資料（記入見本のスキャンなど） |

3つの結果を **RRF（Reciprocal Rank Fusion）** で融合する。`score = Σ 1/(60 + 各ルートでの順位)` で、複数のルートに出てくるものほど上に来る。上位8件（`TOP_K`）をLLMに渡し、**抜粋に書かれていることだけを根拠に**答えさせる。

回答の末尾でAIに「実際に使った抜粋の番号」を申告させ、引用の表示と「答えられたか」の集計に使っている。

検索精度は `rag/eval_search.py`（質問と正解マニュアルの組 `rag/eval_dataset.jsonl`）で測っている。
移行で埋め込みモデルを Titan → bge-m3 に替えたときは **Hit@1 71% → 79%、MRR 0.76 → 0.81** だった（本番データ・2026-09-11）。

---

## リポジトリの構成

```text
manual_search/
├── frontend/          React。画面はすべてここ
│   └── src/
│       ├── components/{chat,manual,layout,ui,auth}
│       ├── graphql/   クエリ定義（型付き）
│       └── lib/       共通処理（認証・トースト・画像・端末判定など）
├── backend/           NestJS。認証・権限・保存・チャットの管理操作・ジョブの発行
│   ├── src/{chat,manual,category,analytics,inquiry,rag,storage,auth,job,user,...}
│   └── prisma/        スキーマとマイグレーション
├── rag/               FastAPI。検索・回答生成・取り込み・分類
│   ├── main.py        エンドポイントと検索本体
│   ├── llm.py         プロンプトと管理操作ツールの定義
│   ├── embedding.py   埋め込みの提供元(hashing / bedrock / workers_ai)
│   ├── vision.py      スキャンページの書き起こし
│   └── tests/         pytest
├── infra/             実際に適用した設定(R2のCORS など。AWS時代のものも記録として残す)
├── docs/              構築・移行の経緯と運用手順
└── scripts/           デプロイ・バックアップ・復元・テスト
```

---

## ローカルで動かす

### 1. 依存サービス（PostgreSQL + S3互換ストレージ）

```bash
cp .env.example .env      # パスワード類を埋める
docker compose up -d      # db / minio / minio-init
```

> ⚠️ `minio/minio` のイメージは Docker Hub から取得できなくなっている（2026-09 時点）。
> 手元にイメージが無い場合は、moto（`pip install "moto[server]"` → `moto_server -p 59000`）など
> 別の S3 互換サーバーで代用できる。バケットとCORSは自分で作る。

### 2. バックエンド

```bash
cd backend
cp .env.example .env      # DATABASE_URL / S3_* / RAG_* を埋める
npm ci
npx prisma migrate deploy
npx prisma generate
npm run start:dev         # http://localhost:3000/graphql
```

認証は `AUTH_PROVIDER=supabase` と `SUPABASE_URL` を設定する（未設定だと旧 Cognito の設定を読みに行く）。
取り込みはローカルでは `INGEST_DISPATCH=inline`（既定）でその場で実行される。

### 3. RAG

```bash
cd rag
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # 既定は外部のAIを使わない設定
uvicorn main:app --reload --port 8000
```

`EMBEDDING_PROVIDER=hashing` / `ANSWER_PROVIDER=stub` が既定なので、**外部サービスの資格情報が無くても起動して一通り触れる**（回答は定型文になる）。
実際のAIを使うなら両方を `workers_ai` にし、`CF_ACCOUNT_ID` / `CF_API_TOKEN` / `EMBEDDING_COLUMN=embedding_v2` を設定する。
backend と同じ `RAG_API_TOKEN` を両方に入れること（片方だけだと検索が全部401になる）。

### 4. フロント

```bash
cd frontend
cp .env.example .env      # VITE_AUTH_PROVIDER=supabase と Supabase の URL / anon キーを埋める
npm ci
npm run dev               # http://localhost:5173
```

> `VITE_AUTH_PROVIDER` と `VITE_GRAPHQL_URL` は**必ずセットで**変える。片方だけだと
> 「ログインは成功するのに中身が全部空」になり、データが消えたように見える。

---

## テスト

```bash
./scripts/test.sh          # backend(jest) + rag(pytest。本番と同じDockerイメージの中で実行)
cd frontend && npm test    # vitest
```

壊れると痛いところだけを残してある。

| 対象 | 内容 |
| --- | --- |
| backend（jest） | 認証設定の解決（Cognito/Supabaseの切り替え）、問い合わせメールの組み立て |
| rag（pytest） | 検索結果の融合(RRF)、隠しフォルダの除外、Workers AI の応答の解析（埋め込み・生成・画像認識）、DBのTLS設定、LLM出力の解析 |
| frontend（vitest） | 認証状態とログアウト、GraphQLの宛先の決定、画像の縮小、サイドバーと検索結果の表示条件 |

型とlintは各ディレクトリで。

```bash
cd frontend && npx tsc -b --noEmit && npm run lint   # lintは0件を保つ
cd backend  && npm run build                          # nest build（型チェック込み）
```

---

## デプロイ

`main` へのpushでは自動デプロイされない（CIは未整備）。秘密の値は `.env.migration`（Git管理外）から読む。

```bash
# 1. backend と rag（Cloud Build でビルド → Cloud Run。rag を先に出す。約6分）
./scripts/deploy-cloudrun.sh

# 2. フロント（ビルドして Cloudflare Pages へ。上げる前にバンドルの宛先を検査する）
./scripts/deploy-pages.sh https://manualy-backend-xxxx.us-west1.run.app
```

- イメージのタグはコミットのハッシュ（`v<sha>`）。`backend/` か `rag/` に未コミットの変更があると
  `-dirty` を付け、動いているイメージを同じタグで上書きしない
- **RAGとバックエンドの両方を変えるときはRAGを先に出す。** 新しいバックエンドが古いRAGを呼ぶ形なら機能が落ちるだけで済むが、逆だと呼び出しが失敗する
- ヘルスチェックは `/health`。**Cloud Run では `/healthz` がGoogleのインフラに横取りされて必ず404になる**ので使わない

### DBマイグレーション

Supabase には手元から直接繋がるので、`migrate deploy` をそのまま流せる。

```bash
cd backend && DATABASE_URL="$SUPABASE_DB_URL" npx prisma migrate deploy
```

1. **先に毎月のバックアップ（下記）を手動実行しておく**
2. `prisma migrate dev --create-only` でSQLを生成し、**手で中身を確認する**
3. 適用後、検索用インデックスが残っているか確認する

> ⚠️ `prisma migrate dev` が生成するSQLには、生SQLで作った検索用インデックス（pg_trgm / HNSW）の `DROP` が必ず混ざる。そのまま流すと**検索が黙って壊れる**。必要な文だけを残して手で書くこと。

---

## 運用

| 項目 | 内容 |
| --- | --- |
| バックアップ | GitHub Actions で**毎月** `pg_dump`（`public` スキーマ）を**非公開リポジトリ**の Release に添付。12世代保持。PDFの原本は R2 が保管先 |
| 死活監視 | Cloud Monitoring の稼働時間チェック（backend・rag・Pages を5分ごと・3地域から）。10分以上失敗するとメール |
| DBの休止対策 | Supabase の無料プランは7日アクセスが無いと一時停止するため、GitHub Actions が3日ごとに実際に `SELECT` を流す |
| ログ | `gcloud run services logs read manualy-backend` / `manualy-rag` |
| ゴミ箱 | 30日を過ぎたものは backend が自動で消す（起動時と1日ごと） |
| AIの無料枠 | Workers AI は**直近24時間で10,000ニューロン**（日次リセットではなく移動窓）。尽きると回答欄に「回復まで数時間〜1日」と出る。質問1回 ≒ 46 |

🔴 **コードのリポジトリは公開している。**ダンプ（社員のメールアドレス・チャット履歴・マニュアル本文が入る）は
絶対にこちらに置かない。

---

## 設計上の判断

作りながら決めたことのうち、後から読んで迷いそうなもの。

- **PDF本体はDBに入れない。** オブジェクトストレージ（R2）に置き、DBはメタデータとベクトルだけを持つ
- **署名付きURLはブラウザに直接渡す。** ファイルの中身がbackendを通らないので、大きなPDFでもメモリを食わない
- **無料で回ることを優先して米国リージョンに置く。** Cloud Run の無料の通信量は北米発だけが対象のため。
  0.1〜0.2秒の遅延と引き換えに月額を0円にした（利用規模は登録8名・実利用2〜3名）
- **AIの申告より人の評価を優先する。** 👍/👎があればそれを使い、無ければAIの `[参照]` 行を見る。どちらも無い場合は「判定できなかった理由」まで記録する（聞き返し・管理操作・生成失敗を「未判定」に混ぜない）
- **隠しフォルダは検索の段階で除く。** 一覧から消すだけでは、AIの回答の根拠として中身が漏れる。
  権限で切り替えず、管理者の質問でも常に除く。鍵付きに置くのは「回答に使ってほしくない資料」で、
  根拠の枠は8件しかないため、混ざると本来出るべきマニュアルが押し出される
- **見える範囲の条件はAND句に入れる。** 除外条件とキーワード条件がどちらも`OR`を使うため、
  同じ階層に並べると後から書いた方が前を上書きし、除外が黙って消える（実際に漏れた）
- **AIの分類は、隠しフォルダを行き先には使うが中身は動かさない。** 行き先から外すと
  「あのフォルダに入れて」という指示が黙って無視される。逆に中身を動かすと、
  AIの判断で隠していた資料が公開フォルダへ出る（AIが新しく作るフォルダは必ず鍵なし）
- **隠しフォルダへ入れたら必ず画面で伝える。** 黙って入れると、一般利用者から
  見えなくなったことに誰も気づけない。伝えられない経路（アップロード時の自動分類は
  取り込みの数分後に走り、画面を閉じている可能性がある）では行き先にしない
- **ゴミ箱から戻すときに鍵の状態を変えない。** 同名フォルダへまとめる処理は、
  鍵の有無が違えばまとめずに別名で戻す。鍵付きフォルダから来た1件を未分類へ
  戻すのも禁止（未分類は誰でも見えるため、フォルダごと復活させる）
- **管理操作は「実行したフリ」を検知する。** AIが本文で「作成しました」と書いてもツールを呼んでいなければ、システムが訂正を追記する
- **チャットの履歴からシステムの成功行（📁📏🔒など）を除いて渡す。** 残すとAIがそれを真似て、実行せずに成功宣言だけ書くようになる
- **モバイルはPDFを別タブで開く。** スマホのブラウザは埋め込みPDFを描き切れず1ページ目で固まるため

---

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/zero-cost-migration-plan.md](docs/zero-cost-migration-plan.md) | 移行先の比較検討（一部は検討時点の記述のまま） |
| [docs/deployment-plan.md](docs/deployment-plan.md) | AWS時代の構築の経緯、費用、実際に踏んだ落とし穴（記録） |
| [docs/er-diagram.md](docs/er-diagram.md) | テーブル構成 |
| [docs/usage-guide/](docs/usage-guide/) | 利用者向けの使い方ガイド（アプリ内から開ける） |
| [HANDOFF.md](HANDOFF.md) | 初期の設計方針と進め方 |
