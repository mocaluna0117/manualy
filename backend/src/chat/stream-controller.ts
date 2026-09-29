import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { UserRole } from '../auth/roles';
import { UserService } from '../user/service';
import { ChatService } from './service';

/** 画面から送られてくる質問(GraphQLのaskQuestionと同じ内容) */
interface StreamBody {
  question: string;
  conversationId?: string | null;
  images?: { base64: string; format: string }[];
}

/**
 * 無通信で切られるまでの余裕(ミリ秒)。
 * CloudFrontのOriginReadTimeoutとALBのidle timeoutがどちらも60秒なので、
 * 検索に時間がかかっている間も接続が保たれるよう定期的に何か送る
 */
const HEARTBEAT_MS = 15_000;

/**
 * チャットの回答を少しずつ返す経路(Server-Sent Events)。
 *
 * GraphQLは1往復で完成した回答を返す作りなので、途中経過を流せない。
 * 既存のaskQuestionはそのまま残し、この経路を足すことで
 * 「数秒待って一気に出る」を「すぐ出始める」に変える。
 * 保存される内容も戻り値もaskQuestionと同じ(ChatService.askを共用)。
 */
@Controller('chat')
export class ChatStreamController {
  constructor(
    private readonly chatService: ChatService,
    private readonly userService: UserService,
  ) {}

  @Post('stream')
  async stream(
    @Body() body: StreamBody,
    @CurrentUser() authUser: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transformが要点。これが無いと途中の中継が圧縮のために溜め込み、
    // せっかくの逐次表示が「最後にまとめて届く」に戻ってしまう
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 検索に時間がかかっている間も接続を保つ(コメント行は画面に影響しない)
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, HEARTBEAT_MS);

    // 「停止」ボタン=接続の切断。正常終了でもcloseは来るので書き終えたかで見分ける
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const user = await this.userService.ensure(authUser);
      send('start', {});
      const result = await this.chatService.ask(
        body.question,
        user.id,
        body.conversationId ?? undefined,
        body.images ?? [],
        controller.signal,
        user.role === UserRole.ADMIN,
        {
          onDelta: (text) => send('delta', { text }),
          // 管理操作や生成失敗で本文が差し替わるときの合図
          onReset: () => send('reset', {}),
        },
      );
      // 確定した回答を必ず送る。画面はこれで置き換えるので、
      // 途中で伏せた分や差し替えがあってもここで辻褄が合う
      send('done', result);
    } catch (e) {
      // 中断は利用者の操作なので、エラーとして騒がない
      if (!controller.signal.aborted) {
        send('error', {
          message: e instanceof Error ? e.message : '不明なエラー',
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}
