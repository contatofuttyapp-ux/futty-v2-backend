-- =====================================================================
-- Futty v2.0 — Migração 049: tranca o acesso direto ao banco
-- (SEGURANCA-REVISAO-10SET.md, secção 2 — bloqueia o deploy)
-- ⚠️ Correr manualmente no SQL Editor do Supabase (service_role/postgres).
-- Idempotente (DROP POLICY IF EXISTS, REVOKE de algo não concedido não
-- falha, ALTER TABLE IF EXISTS, ENABLE RLS já ligado não falha).
--
-- POR QUÊ: o backend nunca fala com o Supabase pela anon key — usa a
-- service_role (que ignora RLS por natureza) em todas as rotas (server.js,
-- routes/*.js). O frontend confirmado (grep) só usa supabase.auth.* (login/
-- sessão), nunca .from()/.storage.from()/.rpc()/.channel(). Ou seja: nada no
-- código precisa que `anon` ou `authenticated` leiam/escrevam tabelas
-- diretamente. Mas as primeiras migrações (001) criaram policies permissivas
-- pensando num uso direto que nunca aconteceu, e nove tabelas mais recentes
-- nunca ligaram RLS — com a anon key (pública, vai no navegador) dava para:
-- ler todos os users (users_select_all using(true)), promover a própria
-- conta a is_super_admin/plan=elite (users_update_self sem restrição de
-- coluna), e entrar como admin em qualquer time (members_insert_self sem
-- restringir role). Depois desta migração a anon key só serve para login —
-- exatamente o que ela deve fazer. Não mexe em auth.*, storage.*, nem nas
-- policies dos buckets (avatars/kits) — só schema public.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) Policies permissivas de 001_schema.sql — as únicas encontradas na
-- auditoria (grep completo de "create policy" em db/migrations: as demais
-- — teams_*, games_*, votes_*, convites_*, game_players_*,
-- champion_photos_select_member, feed_posts_select_member,
-- feed_post_media_select_member — já restringem por is_team_member/
-- is_team_admin/is_game_member; ficam, são inofensivas e viram letra morta
-- com o REVOKE abaixo mesmo assim).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "users_select_all"  ON public.users;
DROP POLICY IF EXISTS "users_update_self" ON public.users;
DROP POLICY IF EXISTS "members_insert_self" ON public.team_members;

-- ---------------------------------------------------------------------
-- (b) Revoga o acesso direto de anon/authenticated a tudo em public —
-- o cinto. "ALL TABLES IN SCHEMA" cobre tabelas E views. Sequences à
-- parte porque não entram em "ALL TABLES".
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Tabelas futuras (deste momento em diante) nascem sem esses grants —
-- pega o comportamento padrão do Supabase de conceder acesso a anon/
-- authenticated em objetos novos do schema public, para o role que corre
-- esta migração (normalmente "postgres" no SQL Editor) e explicitamente
-- também para "postgres", para não depender de qual sessão execute isto.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- (c) RLS em todas as tabelas do schema public — os suspensórios (mesmo
-- com o REVOKE acima já bloqueando, RLS ligada é defesa em profundidade:
-- se um dia alguém conceder GRANT de volta por engano, RLS ainda barra
-- linha a linha). As 16 abaixo já tinham (001/002/003/005/006/014/019/032)
-- — confirmado por grep, ficam de fora. As que faltavam (achado da
-- auditoria) + as do modelo de campeonato N-times (039, ainda "NÃO
-- aplicada" — pode não existir na tua base; por isso todas com IF EXISTS)
-- + user_avatar_slots (não achei CREATE TABLE nas migrações — se existir
-- na tua base por fora delas, esta linha tranca-a também; se não existir,
-- o IF EXISTS não deixa a migração inteira falhar).
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.campeonatos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campeonato_jornadas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campeonatos_v2          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campeonato_times        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.campeonato_confrontos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.gols_jogadores          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rsvp_respostas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.share_declarations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_blocks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.gasto_ia_diario         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.geracao_ia_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.app_config              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_avatar_slots       ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy nova criada nestas 13: sem grant de anon/authenticated
-- (passo b) e sem policy, RLS = acesso zero para esses roles por padrão —
-- exatamente o que se quer. O backend (service_role) ignora RLS e continua
-- a funcionar sem mudança nenhuma.

-- =====================================================================
-- Reversão (não recomendada — reabre o furo; só para depurar em local):
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
-- CREATE POLICY "users_select_all" ON public.users FOR SELECT USING (true);
-- (etc. — ver 001_schema.sql para o texto original das 3 policies)
-- =====================================================================
