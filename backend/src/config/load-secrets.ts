/**
 * 秘密ファイルの読み込みを「importするだけ」で済ませるための入口。
 *
 * main.ts の本体で関数を呼ぶ形にはできない。importは(CommonJSに変換した後の
 * requireも)本体の1行目より先にまとめて評価されるため、
 * `import { AppModule } from './app.module'` の側が先に走り、その過程で
 * モジュール読み込み時に環境変数を見るコードが空の値を掴んでしまう。
 * 副作用だけの小さなモジュールを main.ts の1行目でimportして、
 * 他の依存が解決されるより前に必ず走らせる。
 */
import { loadSecretsFile } from './secrets';

const applied = loadSecretsFile();
if (applied > 0) {
  // 値は絶対に出さない。何件入ったかだけ残す(マウント漏れの切り分け用)
  console.log(
    `[secrets] ${applied}件の設定をマウントしたJSONから読み込みました`,
  );
}

// DBのTLSの検査はここには置かない(以前は置いていた)。
// ここを通るのは main.ts から起動するサーバー本体だけで、
// src/scripts/ 配下は PrismaService を直接組み立てるため素通りしてしまう。
// 「DBに繋ぐ経路は必ず通る」PrismaService のコンストラクタへ移した
// (prisma/service.ts)。秘密の展開はそれより先に済むので順番の問題も無い
