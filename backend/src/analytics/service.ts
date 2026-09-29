import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';

/** 集計に渡せる期間の上限(日)。0や未指定は「全期間」 */
const MAX_DAYS = 365;

/** 一覧で返す最大件数(画面で読める量に抑える) */
const LIMIT = 200;

/**
 * チャット履歴から「マニュアルが足りていない領域」を見つけるための集計。
 *
 * このアプリの値打ちはマニュアルが育つことなので、
 * 「答えられなかった質問」「よく聞かれること」「使われていないマニュアル」を
 * 見えるようにして、次に何を用意すべきかが分かる状態にする。
 * 誰が質問したかは扱わない(内容だけを集計する)。
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
  ) {}

  /** 期間指定をSQLで使う開始日時に変換する(未指定なら全期間) */
  private since(days?: number): Date | null {
    if (!days || days <= 0) return null;
    const capped = Math.min(days, MAX_DAYS);
    return new Date(Date.now() - capped * 24 * 60 * 60 * 1000);
  }

  /**
   * AIが「マニュアルに根拠が無い」と申告した回答と、その質問を返す。
   *
   * 質問は「同じ会話の、その回答の直前のユーザー発言」。
   * 会話ごとに時系列で並んでいるので、直前の1件を取れば対になる。
   */
  async unansweredQuestions(days?: number) {
    const since = this.since(days);
    type Row = {
      id: string;
      question: string | null;
      answer: string;
      asked_at: Date;
      rated_bad: boolean;
      feedback_reason: string | null;
    };
    // 人が👎を押したものは、AIが「答えられた」と申告していても拾う。
    // 逆に👍が付いていれば、AIの申告に関わらずここには出さない。
    // 期間の有無でSQLを分けるのは、1本にまとめて (パラメータ IS NULL OR ...)
    // と書くと汎用プランでcreated_atの索引が使われなくなるため
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        a.id,
        (
          SELECT q.content FROM "Message" q
          WHERE q.conversation_id = a.conversation_id
            AND q.role = 'USER'
            AND q.created_at <= a.created_at
          ORDER BY q.created_at DESC
          LIMIT 1
        ) AS question,
        a.content AS answer,
        a.created_at AS asked_at,
        -- NULL = 'BAD' はfalseではなくNULLになる。そのまま返すと
        -- GraphQLの非nullな項目に入れられずエラーになるので、falseに畳む
        COALESCE(a.feedback = 'BAD', false) AS rated_bad,
        a.feedback_reason
      FROM "Message" a
      WHERE a.role = 'ASSISTANT'
        AND (
          a.feedback = 'BAD'
          OR (a.feedback IS NULL AND a.answered_from_manuals = false)
        )
        ${since ? Prisma.sql`AND a.created_at >= ${since}` : Prisma.empty}
      ORDER BY a.created_at DESC
      LIMIT ${LIMIT}
    `;
    // 質問が見つからない回答(会話の作りが壊れている場合)は出さない
    return rows
      .filter((r) => r.question)
      .map((r) => ({
        id: r.id,
        question: r.question as string,
        answer: r.answer,
        askedAt: r.asked_at,
        ratedBad: r.rated_bad,
        feedbackReason: r.feedback_reason,
      }));
  }

  /**
   * 答えられなかった質問から、マニュアルの下書きを作る。
   *
   * 利用状況で「足りない領域」が見えても、そこから書き始めるのは重い。
   * 章立てと分かっている範囲を先に用意して、担当者が直す形にする
   */
  async draftManual(question: string) {
    const text = question.trim();
    if (!text) {
      throw new BadRequestException('質問を指定してください');
    }
    return this.rag.draftManual(text);
  }

  /** 集計対象の質問文だけを新しい順に返す(テーマ分けの入力に使う) */
  private async recentQuestions(days?: number): Promise<string[]> {
    const since = this.since(days);
    const rows = await this.prisma.message.findMany({
      where: {
        role: 'USER',
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300, // RAG側の上限に合わせる
      select: { content: true },
    });
    // 画像添付の注記や前後の空白は集計の邪魔なので落とす
    return rows
      .map((r) => r.content.replace(/\n\(📷 画像を添付\)$/, '').trim())
      .filter((q) => q.length > 0);
  }

  /**
   * 質問をテーマごとにまとめる(AIを使う)。
   * 押したときだけ実行する想定なので、ここでは結果を保存しない
   */
  async questionThemes(days?: number) {
    const questions = await this.recentQuestions(days);
    if (questions.length === 0) return [];
    return this.rag.clusterQuestions(questions);
  }

  /**
   * マニュアルが回答の根拠として何回使われたかを返す(多い順)。
   * 一度も使われていないマニュアルも0件として含める(棚卸しに使う)
   */
  async manualUsage(days?: number) {
    const since = this.since(days);
    // citationsは回答時点のスナップショット。JSON配列を展開して数える。
    //
    // COUNT(DISTINCT m.id) にするのが要点。1つの回答が同じマニュアルの
    // 複数ページを根拠にすると引用の要素は複数になるため、そのまま数えると
    // 多ページのPDFだけが上位に来てしまう。数えたいのは「何回の回答で
    // 使われたか」なのでメッセージ単位で重複を除く
    type CountRow = { manual_id: string; cited: bigint; last_cited: Date };
    const counts = since
      ? await this.prisma.$queryRaw<CountRow[]>`
          SELECT
            c->>'manualId' AS manual_id,
            COUNT(DISTINCT m.id) AS cited,
            MAX(m.created_at) AS last_cited
          FROM "Message" m,
               LATERAL jsonb_array_elements(m.citations) c
          WHERE m.role = 'ASSISTANT'
            AND jsonb_typeof(m.citations) = 'array'
            AND m.created_at >= ${since}
          GROUP BY 1
        `
      : await this.prisma.$queryRaw<CountRow[]>`
          SELECT
            c->>'manualId' AS manual_id,
            COUNT(DISTINCT m.id) AS cited,
            MAX(m.created_at) AS last_cited
          FROM "Message" m,
               LATERAL jsonb_array_elements(m.citations) c
          WHERE m.role = 'ASSISTANT'
            AND jsonb_typeof(m.citations) = 'array'
          GROUP BY 1
        `;
    const byManual = new Map(
      counts.map((c) => [
        c.manual_id,
        { cited: Number(c.cited), lastCited: c.last_cited },
      ]),
    );

    // ゴミ箱のマニュアルは棚卸しの対象外(もう使わないと決めたもの)
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: null },
      select: { id: true, title: true, category: { select: { name: true } } },
    });

    return manuals
      .map((manual) => {
        const hit = byManual.get(manual.id);
        return {
          manualId: manual.id,
          title: manual.title,
          categoryName: manual.category?.name ?? null,
          citedCount: hit?.cited ?? 0,
          lastCitedAt: hit?.lastCited ?? null,
        };
      })
      .sort(
        (a, b) =>
          b.citedCount - a.citedCount || a.title.localeCompare(b.title, 'ja'),
      );
  }

  /**
   * 回答1件ずつを「どの箱に入るか」に分ける式。
   *
   * 人が押した評価を最優先にする。AIの自己申告は「抜粋を根拠にしたか」しか
   * 見ておらず、根拠はあっても知りたいことに答えていない回答を拾えないため。
   * 聞き返し・管理操作・検索対象ゼロは、可否を数えても意味が無いので分ける。
   */
  private static readonly BUCKET = Prisma.sql`
    CASE
      WHEN feedback = 'GOOD' THEN 'answered'
      WHEN feedback = 'BAD' THEN 'unanswered'
      WHEN answered_from_manuals = true THEN 'answered'
      WHEN answered_from_manuals = false THEN 'unanswered'
      WHEN answer_outcome IN ('clarify', 'admin', 'no_manuals') THEN 'out_of_scope'
      WHEN answer_outcome = 'failed' THEN 'failed'
      WHEN answer_outcome = 'unreported' THEN 'unreported'
      ELSE 'not_recorded'
    END`;

  /** 画面の見出しに出す全体像 */
  async summary(days?: number) {
    const since = this.since(days);
    const where = since ? { createdAt: { gte: since } } : {};
    type Counts = {
      answered: bigint;
      unanswered: bigint;
      out_of_scope: bigint;
      failed: bigint;
      unreported: bigint;
      not_recorded: bigint;
      rated_good: bigint;
      rated_bad: bigint;
    };
    const [questionCount, rows, usage] = await Promise.all([
      this.prisma.message.count({ where: { ...where, role: 'USER' } }),
      this.prisma.$queryRaw<Counts[]>`
        SELECT
          count(*) FILTER (WHERE bucket = 'answered') AS answered,
          count(*) FILTER (WHERE bucket = 'unanswered') AS unanswered,
          count(*) FILTER (WHERE bucket = 'out_of_scope') AS out_of_scope,
          count(*) FILTER (WHERE bucket = 'failed') AS failed,
          count(*) FILTER (WHERE bucket = 'unreported') AS unreported,
          count(*) FILTER (WHERE bucket = 'not_recorded') AS not_recorded,
          count(*) FILTER (WHERE feedback = 'GOOD') AS rated_good,
          count(*) FILTER (WHERE feedback = 'BAD') AS rated_bad
        FROM (
          SELECT feedback, ${AnalyticsService.BUCKET} AS bucket
          FROM "Message"
          WHERE role = 'ASSISTANT'
          ${since ? Prisma.sql`AND created_at >= ${since}` : Prisma.empty}
        ) t`,
      this.manualUsage(days),
    ]);
    const c = rows[0];
    const n = (v: bigint) => Number(v);
    return {
      questionCount,
      answeredCount: n(c.answered),
      unansweredCount: n(c.unanswered),
      // 聞き返し・管理操作・検索対象ゼロ。数えても意味が無いもの
      outOfScopeCount: n(c.out_of_scope),
      // 生成に失敗した(マニュアルの有無とは無関係の障害)
      failedCount: n(c.failed),
      // 通常の回答なのにAIが根拠を申告せず、可否を判定できなかったもの。
      // ここが増えていたら、集計の仕組み自体を疑う手がかりになる
      unreportedCount: n(c.unreported),
      // この結末を記録し始める前に保存されたデータ
      notRecordedCount: n(c.not_recorded),
      // 人が押した評価の数(AIの判定より確かな根拠として別に見せる)
      ratedGoodCount: n(c.rated_good),
      ratedBadCount: n(c.rated_bad),
      // 古い画面との互換のために残す(内訳を出せない場合の合計)
      unknownCount:
        n(c.out_of_scope) + n(c.failed) + n(c.unreported) + n(c.not_recorded),
      neverCitedManualCount: usage.filter((u) => u.citedCount === 0).length,
    };
  }
}
