import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RagAnswer } from './model';

// Pythonサービスが返すJSONの形(snake_case)
// Claudeが要求した管理操作(フォルダ作成など)。GraphQLには出さず、
// ChatServiceが内容を見て実行する
export interface RagAction {
  name: string;
  input: Record<string, unknown>;
}

/**
 * モデルやSSEが返してきた値を文字列として受け取る。
 *
 * 中身はモデル任せなので、文字列のつもりの場所にオブジェクトや配列が
 * 入ってくることがある。String()に通すと「[object Object]」という名前の
 * フォルダがそのまま作られてしまうため、文字列・数値・真偽値だけを受け付けて、
 * それ以外は空文字にする(呼び出し側の「空なら聞き返す」に合流させる)。
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

interface RagSearchResponse {
  answer: string;
  citations: {
    manual_id: string;
    title: string;
    snippet: string;
    page: number | null;
  }[];
  options: string[];
  actions?: RagAction[];
  // マニュアルから答えられたか(null=判断材料なし)。利用状況の集計に使う
  answered?: boolean | null;
  // 判定できなかった理由まで分かる結末(answeredはここから導かれている)
  outcome?: string | null;
}

// 用途ごとのタイムアウト(ミリ秒)。
// 取り込みはスキャンPDFの書き起こし(最大30ページ×Claude)があるため長い。
// タイムアウトが無いとRAG側が応答しないときにbackendの接続が延々ぶら下がる
const TIMEOUT_MS = {
  health: 5_000,
  search: 90_000,
  organize: 180_000,
  ingest: 900_000, // 15分
} as const;

// Python(FastAPI)のRAGサービスを呼ぶHTTPクライアント。
// GraphQLの世界(フロント向け)とRAGの世界(Python)の橋渡し役
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly baseUrl =
    process.env.RAG_SERVICE_URL ?? 'http://localhost:8000';
  private readonly apiToken = process.env.RAG_API_TOKEN ?? '';

  /**
   * RAGサービスを呼ぶ共通処理。
   * - 共有トークンを付ける(RAG側は未認証だと401を返す)
   * - 用途に応じたタイムアウトを掛け、応答しない場合に呼び出し側を巻き込まない
   */
  private async request(
    path: string,
    timeoutMs: number,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Token': this.apiToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // タイムアウトに加えて、呼び出し元の中断(チャットの停止ボタン)でも打ち切る
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // タイムアウトも通信断もここに来る。原因が分かる形で伝える
      const reason =
        e instanceof Error && e.name === 'TimeoutError'
          ? `応答がありません(${Math.round(timeoutMs / 1000)}秒でタイムアウト)`
          : '接続できません';
      throw new ServiceUnavailableException(`RAGサービスに${reason}`);
    }
  }

  async health(): Promise<string> {
    const res = await this.request('/health', TIMEOUT_MS.health);
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `RAGサービスが異常です (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as { status: string };
    return body.status;
  }

  /** ファイルの取り込み(テキスト抽出→チャンク分割→DB保存)をPythonに依頼する */
  async ingest(
    manualId: string,
    downloadUrl: string,
    fileName: string,
  ): Promise<{ chunkCount: number; pdfCreatedAt: Date | null }> {
    // RAGが再起動している最中は503が返る。取り込みは重くて再実行の負担が
    // 大きいので、少し待って一度だけやり直す(起動には1分ほどかかる)
    let res = await this.request('/ingest', TIMEOUT_MS.ingest, {
      manual_id: manualId,
      download_url: downloadUrl,
      file_name: fileName,
    });
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      this.logger.warn(
        `取り込みが HTTP ${res.status} で失敗したので、90秒後にもう一度試します manual=${manualId}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      res = await this.request('/ingest', TIMEOUT_MS.ingest, {
        manual_id: manualId,
        download_url: downloadUrl,
        file_name: fileName,
      });
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `ファイルの取り込みに失敗しました (HTTP ${res.status})。` +
          '右クリックの「再取り込み」からやり直せます',
      );
    }
    const body = (await res.json()) as {
      chunk_count: number;
      pdf_created_at?: string | null;
    };
    // 日付が壊れているPDFもあるので、解釈できないものはnull扱いにする
    const parsed = body.pdf_created_at ? new Date(body.pdf_created_at) : null;
    return {
      chunkCount: body.chunk_count,
      pdfCreatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    };
  }

  /**
   * タイトルだけが変わったときに、ベクトルを作り直す。
   * 本文は変わっていないのでファイルの読み直しは不要
   */
  async reembedTitle(manualId: string): Promise<number> {
    const res = await this.request('/reembed-title', TIMEOUT_MS.organize, {
      manual_id: manualId,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `検索用データの更新に失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as { chunk_count: number };
    return body.chunk_count;
  }

  /** マニュアル一覧のカテゴリ分けをAIに依頼する(判断だけ返る。DB反映は呼び出し側) */
  async organize(
    manuals: { manualId: string; title: string; snippet: string }[],
    categories: string[],
    allowNew = true, // falseなら既存カテゴリだけに割り当てる(新カテゴリを作らせない)
    instruction?: string, // 管理者が指定した分類方針(例:「工種ごとに」)
    rules?: string[], // 管理者が蓄積した分類ルール(最優先で適用)
  ): Promise<
    { manualId: string; category: string | null; candidates: string[] }[]
  > {
    const res = await this.request('/organize', TIMEOUT_MS.organize, {
      manuals: manuals.map((m) => ({
        manual_id: m.manualId,
        title: m.title,
        snippet: m.snippet,
      })),
      categories,
      allow_new: allowNew,
      instruction: instruction ?? null,
      rules: rules ?? [],
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `自動分類に失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as {
      assignments: {
        manual_id: string;
        category?: string;
        // ルールが競合したときは行き先を決めず、候補だけが返る
        candidates?: string[];
      }[];
    };
    return body.assignments.map((a) => ({
      manualId: a.manual_id,
      category: a.category ?? null,
      candidates: (a.candidates ?? []).filter((c) => c.trim().length > 0),
    }));
  }

  async search(
    question: string,
    images: { base64: string; format: string }[] = [],
    history?: { role: 'user' | 'assistant'; content: string }[],
    signal?: AbortSignal,
    isAdmin = false, // trueなら管理ツール(フォルダ作成・再分類)が有効になる
  ): Promise<RagAnswer & { actions: RagAction[] }> {
    const res = await this.request(
      '/search',
      TIMEOUT_MS.search,
      {
        question,
        images,
        history: history ?? [],
        is_admin: isAdmin,
      },
      signal,
    );
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `RAGサービスがエラーを返しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as RagSearchResponse;
    // Python流(snake_case)をGraphQL流(camelCase)に変換して返す
    return {
      answer: body.answer,
      citations: body.citations.map((c) => ({
        manualId: c.manual_id,
        title: c.title,
        snippet: c.snippet,
        pageNumber: c.page ?? null,
      })),
      options: body.options ?? [],
      actions: body.actions ?? [],
      answered: body.answered ?? null,
      outcome: body.outcome ?? null,
    };
  }

  /**
   * search と同じ回答を、文字が生成されるそばから受け取る。
   *
   * onDelta は追加された文字ごとに呼ばれる。onReset は「ここまでの途中経過は
   * 捨ててよい」合図(管理操作や生成失敗で本文が差し替わるとき)。
   * 戻り値は search と同じで、確定した回答・引用・選択肢
   */
  async searchStream(
    question: string,
    images: { base64: string; format: string }[],
    history: { role: 'user' | 'assistant'; content: string }[] | undefined,
    signal: AbortSignal | undefined,
    isAdmin: boolean,
    onDelta: (text: string) => void,
    onReset: () => void,
  ): Promise<RagAnswer & { actions: RagAction[] }> {
    const res = await this.request(
      '/search-stream',
      TIMEOUT_MS.search,
      {
        question,
        images,
        history: history ?? [],
        is_admin: isAdmin,
      },
      signal,
    );
    if (!res.ok || !res.body) {
      throw new ServiceUnavailableException(
        `RAGサービスがエラーを返しました (HTTP ${res.status})`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    type DoneEvent = {
      answer: string;
      citations: {
        manual_id: string;
        title: string;
        snippet: string;
        page: number | null;
      }[];
      options: string[];
      actions?: RagAction[];
      answered?: boolean | null;
      outcome?: string | null;
    };
    let done: DoneEvent | null = null;
    let failure: string | null = null;

    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      // SSEは空行1つで1件の区切り
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /^event: (\w+)$/m.exec(block)?.[1];
        const raw = /^data: (.*)$/m.exec(block)?.[1];
        if (event && raw) {
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (event === 'delta') onDelta(asText(data.text));
          else if (event === 'reset') onReset();
          else if (event === 'error')
            failure = asText(data.message) || '不明なエラー';
          else if (event === 'done') done = data as unknown as DoneEvent;
        }
        sep = buffer.indexOf('\n\n');
      }
    }

    if (failure) throw new ServiceUnavailableException(failure);
    if (!done) {
      throw new ServiceUnavailableException(
        'RAGサービスの応答が途中で切れました',
      );
    }
    return {
      answer: done.answer,
      citations: done.citations.map((c) => ({
        manualId: c.manual_id,
        title: c.title,
        snippet: c.snippet,
        pageNumber: c.page ?? null,
      })),
      options: done.options ?? [],
      actions: done.actions ?? [],
      answered: done.answered ?? null,
      outcome: done.outcome ?? null,
    };
  }

  /**
   * 質問文をテーマごとにまとめる(利用状況の集計用)。
   * 語尾違いの同じ質問がバラバラに数えられるのを防ぐ
   */
  async clusterQuestions(questions: string[]) {
    const res = await this.request('/cluster-questions', TIMEOUT_MS.organize, {
      questions,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `集計に失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as {
      themes: { theme: string; count: number; examples: string[] }[];
    };
    return body.themes ?? [];
  }

  /**
   * 答えられなかった質問から、マニュアルの下書きを作る。
   * DBには何も書かず、下書きの文面と材料にした資料を返すだけ
   */
  async draftManual(question: string) {
    const res = await this.request('/draft-manual', TIMEOUT_MS.organize, {
      question,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `下書きを作れませんでした (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as {
      draft: string;
      sources?: { manual_id: string; title: string; page: number | null }[];
    };
    return {
      draft: body.draft,
      sources: (body.sources ?? []).map((s) => ({
        manualId: s.manual_id,
        title: s.title,
        pageNumber: s.page ?? null,
      })),
    };
  }
}
