-- =====================================================================
-- Futty v2.0 — Migração 082: tranca as tabelas que nasceram depois da 049 sem a trava completa
-- (varredura de segurança da estreia, 12-out). Idempotente e só restringe.
-- ⚠️ PROPOSTA — NÃO FOI APLICADA. Correr manualmente no SQL Editor do Supabase (DDL é do utilizador),
-- DEPOIS das migrações 057, 058, 072, 078 e 080 (cada uma cria uma das tabelas abaixo; sem a tabela, o
-- REVOKE/GRANT falha com "relation does not exist" — corra só quando todas existirem).
--
-- POR QUÊ: a regra da casa (049) é "tabela nova nasce trancada": RLS ligado, sem acesso de anon/authenticated,
-- GRANT só para o service_role (o motor). Lendo as migrações em ordem, cinco tabelas ficaram a meio caminho:
--
--   tabela                  RLS     REVOKE anon/auth.   GRANT service_role
--   fotos_recusadas  (080)  FALTA   FALTA               FALTA     <- a única SEM row level security
--   sorteio_codigos  (078)  ok      FALTA               FALTA
--   user_avatar_historico (057) ok  FALTA               FALTA
--   convite_codigos  (072)  ok      FALTA               ok
--   convite_usos     (058)  ok      FALTA               ok
--
-- 1) `fotos_recusadas` guarda o sha256 das fotos recusadas e o id de quem as mandou. Sem RLS ela aparece em
--    `gabinete_rls_status().tabelas_sem_rls` e o semáforo "banco trancado" do Gabinete deixa de ficar verde. Hoje
--    o que a protege é só o default privileges da 049 (que tirou anon/authenticated dos objetos novos do `postgres`):
--    uma única linha de GRANT por engano, e a lista de fotos recusadas ficaria legível pela chave pública.
-- 2) O Supabase muda a regra de grants dos objetos novos em 30-out: depois dessa data, tabela criada sem GRANT
--    explícito não é visível nem para a chave secreta (service_role). Quem recriar o banco (o projeto novo do "dia do
--    dinheiro") e rodar as migrações em ordem depois de 30-out precisa destes GRANTs, ou o motor recebe "permission
--    denied" nestas tabelas (convite curto, link curto do sorteio, histórico de figurinhas e a lista de fotos recusadas).
--
-- O motor usa a chave secreta (service_role), que ignora RLS e passa a ter o GRANT explícito: nada muda para ele.
-- =====================================================================

-- fotos_recusadas (080)
ALTER TABLE IF EXISTS public.fotos_recusadas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fotos_recusadas FROM PUBLIC;
REVOKE ALL ON TABLE public.fotos_recusadas FROM anon, authenticated;
GRANT ALL ON TABLE public.fotos_recusadas TO service_role;

-- sorteio_codigos (078)
ALTER TABLE IF EXISTS public.sorteio_codigos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sorteio_codigos FROM PUBLIC;
REVOKE ALL ON TABLE public.sorteio_codigos FROM anon, authenticated;
GRANT ALL ON TABLE public.sorteio_codigos TO service_role;

-- user_avatar_historico (057)
ALTER TABLE IF EXISTS public.user_avatar_historico ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_avatar_historico FROM PUBLIC;
REVOKE ALL ON TABLE public.user_avatar_historico FROM anon, authenticated;
GRANT ALL ON TABLE public.user_avatar_historico TO service_role;

-- convite_codigos (072) — já tinha o GRANT; falta tirar o acesso público
ALTER TABLE IF EXISTS public.convite_codigos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.convite_codigos FROM PUBLIC;
REVOKE ALL ON TABLE public.convite_codigos FROM anon, authenticated;
GRANT ALL ON TABLE public.convite_codigos TO service_role;

-- convite_usos (058) — idem
ALTER TABLE IF EXISTS public.convite_usos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.convite_usos FROM PUBLIC;
REVOKE ALL ON TABLE public.convite_usos FROM anon, authenticated;
GRANT ALL ON TABLE public.convite_usos TO service_role;

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER:
--   select public.gabinete_rls_status();                          -- {"tabelas_sem_rls": [], "policies_users": 0}
--   select has_table_privilege('anon', 'public.fotos_recusadas', 'select');          -- false
--   select has_table_privilege('service_role', 'public.fotos_recusadas', 'insert');  -- true
-- Reversão (não recomendada): não há — remover a trava reabriria o que a 049 fechou.
-- =====================================================================
