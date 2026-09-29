-- Supabase の public スキーマを anon / authenticated から閉じる
--
-- なぜ要るか(2026-09-10 実測):
--   public の13表すべてが RLS 無効・ポリシー0本で、anon に SELECT も DELETE も
--   TRUNCATE も付いている。anon キーは公開前提の鍵なので frontend/.env.production
--   (Git管理下)にも、配信中の https://manualy.pages.dev のバンドルにも平文で入っている。
--   その先にあるのは本番データの写し(User 8件のメールアドレス / Message 369件 /
--   Manual 329件 / ManualChunk 4,424件)。
--   いま外から読めないのは PostgREST が 503(PGRST002)を返しているからで、
--   これは対策ではない。復旧すればそのまま読める。
--
-- なぜ REVOKE だけでは足りないか:
--   public スキーマに ALTER DEFAULT PRIVILEGES が仕掛けてあり、postgres と
--   supabase_admin が作る表に anon/authenticated へ自動で arwdDxtm が付く。
--   表単位で REVOKE しても、9/15 の restore-to-supabase.sh が表を作り直した瞬間に元へ戻る。
--   だから「スキーマへの USAGE を落とす」+「既定権限の仕掛けを外す」の両方をやる。
--
-- 壊れないことの根拠:
--   アプリは PostgREST(/rest/v1)を1か所も使っていない。frontend の supabase-js は
--   認証専用(AuthProvider / LoginScreen / SettingsDialog / Sidebar)で .from() も .rpc() も無い。
--   backend は Prisma が postgres ロールで直接つなぐ。Supabase Auth は auth スキーマと
--   supabase_auth_admin ロールで動くので、public を閉じても影響しない。
--
-- 流し方:
--   set -a && . ./.env.migration && set +a
--   /opt/homebrew/opt/postgresql@17/bin/psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/lock-supabase-public.sql
--
-- 元に戻すには(下の「戻す」節を流す)

BEGIN;

-- 肝。表単位の GRANT より上位なので、表を作り直しても効いたまま
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

-- いまある表・シーケンス・関数の権限も落とす
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- これから作る表に自動で権限が付く仕掛けを外す(復元で元に戻らないように)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMIT;

-- 確認(すべて f になれば閉じている。service_role だけ t のまま)
SELECT has_schema_privilege('anon','public','USAGE')              AS anon_スキーマ,
       has_table_privilege('anon','public."User"','SELECT')       AS anon_User読取,
       has_table_privilege('authenticated','public."Message"','SELECT') AS auth_Message読取,
       has_table_privilege('service_role','public."User"','SELECT')     AS service_role読取;

-- ============================================================
-- 戻す(必要になったときだけ)
-- ============================================================
-- BEGIN;
-- GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
-- COMMIT;
