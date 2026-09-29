import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public';

/**
 * ALB(ロードバランサ)のヘルスチェック用エンドポイント。
 *
 * GETで叩けて認証不要である必要がある:
 * - GraphQLは POST /graphql なのでヘルスチェックに使えない
 * - 認証ガードはRESTにも適用されるため @Public() が必須
 *   (付けないと401になり、ALBが「異常」と判定してタスクを落とし続ける)
 *
 * あえて「生存確認のみ」でDBやRAGサービスは見ない。
 * 依存先の障害でヘルスチェックを落とすと、ECSがタスクを次々に入れ替えて
 * 状況を悪化させるだけで復旧しないため(DBが落ちているのはタスクの責任ではない)。
 *
 * 「/healthz」と「/health」の両方で応答する。
 * Cloud Run では /healthz が使えない。Google のインフラが Cloud Run へ渡す前に
 * 横取りして自前の404ページを返す(応答に server: Google Frontend が付かないことで
 * 判別できる)。実測: /healthz だけが届かず、/health /healthz2 /livez /readyz /zzz は届く。
 * rag(/healthz を定義していない)でも同じなので、アプリ側ではどうにもならない。
 * ALB(AWS)は /healthz を見ているので消せない。両方に応えるのがいちばん安全。
 */
@Controller()
export class HealthController {
  @Public()
  @Get(['healthz', 'health'])
  healthz() {
    return { status: 'ok' };
  }
}
