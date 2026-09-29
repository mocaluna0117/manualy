# Codex Handoff

## Project

社内マニュアル検索システム。

目的は、RAG による AI 検索とキーワード検索を組み合わせて、社内マニュアルを提示する Web アプリを作ること。

## Current Repository State

- Branch: `main`
- Remote tracking: `origin/main`
- Latest commits:
  - `d71f54a dockerの構築`
  - `8bae783 firstcommit gitignoreとREADMEの作成`
- Working tree:
  - `backend/` が未追跡ファイルとして追加済み
  - `frontend/` と `rag/` は現時点では空ディレクトリ
  - `.env` は存在するが、秘密情報のためこの引き継ぎには内容を記載しない

## Existing Files

- [README.md](README.md): プロジェクト概要
- [docker-compose.yml](docker-compose.yml): PostgreSQL + pgvector 用の Docker Compose
- [.env.example](.env.example): PostgreSQL 用の環境変数例
- [backend/](backend/): NestJS の初期 scaffold

## Docker / Database

`docker-compose.yml` では以下のサービスが定義されている。

- `db`
  - Image: `pgvector/pgvector:pg16`
  - Container name: `manual_search_db`
  - Port: `${POSTGRES_PORT}:5432`
  - Data volume: `./.volumes/db:/var/lib/postgresql/data`
  - Healthcheck: `pg_isready`

`.env.example` の値:

```env
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DB=manual_search
POSTGRES_PORT=54321
```

## Backend

`backend/` は NestJS の初期プロジェクト。

主なスクリプト:

```bash
npm run start
npm run start:dev
npm run build
npm run lint
npm run test
npm run test:e2e
```

現状の実装:

- [backend/src/app.module.ts](backend/src/app.module.ts): `AppController` と `AppService` のみ
- [backend/src/app.controller.ts](backend/src/app.controller.ts): `GET /` で hello を返す
- [backend/src/app.service.ts](backend/src/app.service.ts): `Hello World!` を返す

## Claude Code Context To Paste Here

Claude Code 側の会話・要約・TODO がある場合は、この欄に貼る。

特に欲しい情報:

- 今やろうとしていた具体的な作業
- 決まっている技術選定
- 保留中の TODO
- 迷っていた設計判断
- 直近で Claude Code に依頼した内容
- Claude Code が出したエラー、未解決の問題

## Suggested Next Steps For Codex

Claude Code 側の追加情報がない場合、Codex では以下から進めるのが自然。

1. `backend/` を Git 管理対象として扱うか確認する
2. NestJS バックエンドに PostgreSQL 接続設定を追加する
3. pgvector 拡張を有効化する migration または初期化処理を用意する
4. マニュアル文書、検索インデックス、検索 API の設計を決める
5. `frontend/` の技術選定と初期 scaffold を行う
6. `rag/` に embedding / chunking / retrieval まわりを実装するか、backend に統合するか決める

