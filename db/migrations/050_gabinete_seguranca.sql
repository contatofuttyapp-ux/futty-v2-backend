-- =====================================================================
-- Futty v2.0 — Migração 050: função de diagnóstico RLS para o Gabinete
-- (painel Segurança 2.0, semáforo "banco trancado")
-- ⚠️ Correr manualmente no SQL Editor do Supabase (service_role/postgres).
-- Idempotente (CREATE OR REPLACE FUNCTION).
--
-- POR QUÊ: depois da migração 049 (tranca o banco), o semáforo "banco
-- trancado" da aba Segurança precisa de uma forma de CONFIRMAR isso ao
-- vivo, não só confiar que a 049 foi corrida um dia. PostgREST (a única
-- via que o backend tem ao banco — sem connection string de Postgres, sem
-- "pg" instalado) não expõe pg_catalog/information_schema por padrão, por
-- isso a confirmação vem de uma função SQL dedicada, exposta só ao
-- service_role (que é como o backend fala com o Supabase em toda a app).
--
-- O QUE DEVOLVE:
--   tabelas_sem_rls  — nomes das tabelas do schema public com RLS
--                       desligado (relrowsecurity = false). Vazio = ok.
--   policies_users    — nº de row-level policies na tabela users. Depois
--                       da 049 (que removeu users_select_all e
--                       users_update_self, as únicas que lá existiam),
--                       o valor esperado é 0.
-- Semáforo verde no painel = tabelas_sem_rls vazio E policies_users = 0.
-- Enquanto esta função não existir (migração por correr), o painel mostra
-- "a confirmar" em vez de arriscar um verde/vermelho errado.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.gabinete_rls_status()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'tabelas_sem_rls', (
      SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'          -- só tabelas normais, não views/sequences
        AND c.relrowsecurity = false
    ),
    'policies_users', (
      SELECT count(*)::int
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'users'
    )
  );
$$;

-- Dona explícita (postgres) e EXECUTE só para service_role — anon/authenticated
-- continuam sem qualquer via de introspecção do schema via PostgREST.
ALTER FUNCTION public.gabinete_rls_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gabinete_rls_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gabinete_rls_status() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gabinete_rls_status() TO service_role;
