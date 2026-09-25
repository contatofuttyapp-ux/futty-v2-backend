-- =====================================================================
-- Futty v2.0 — Migração 061: telemetria ANÔNIMA de velocidade (Rodada 28, bloco E)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: o botão de Diagnóstico saiu do Perfil (bloco D). No lugar, o app manda
-- sozinho, no máximo uma vez por tela por sessão, quanto a tela levou para ficar útil
-- e quanto cada chamada ao motor custou (POST /api/telemetria). O Gabinete mostra
-- p50/p95 por tela e por versão e as 5 rotas mais lentas (aba Velocidade).
--
-- ANÔNIMA POR CONSTRUÇÃO: esta tabela NÃO TEM coluna para usuário, e-mail, IP nem
-- identificador de aparelho — não há onde guardar. Telas e rotas chegam como padrão
-- (/equipa/:slug/ranking), sem slug de time nem id (utils/telemetria.js).
--
-- SEM esta migração: o motor responde 204 e não grava nada (aviso no log); a aba
-- Velocidade do Gabinete diz que falta a migração. Nada no app depende disto.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.telemetria_velocidade (
  id          bigserial PRIMARY KEY,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  -- 'producao' = gravado pelo motor no Cloud Run; 'teste' = motor local/bancada (o banco é
  -- o mesmo dos dois). O Gabinete só conta 'producao'.
  ambiente    text NOT NULL DEFAULT 'producao' CHECK (ambiente IN ('producao', 'teste')),
  tela        text NOT NULL CHECK (char_length(tela) BETWEEN 1 AND 100),
  ms_util     integer NOT NULL CHECK (ms_util BETWEEN 0 AND 120000),
  -- { "/api/teams/:slug/ranking": { "ms": 540, "motor": 120 }, ... } — até 20 rotas.
  chamadas    jsonb NOT NULL DEFAULT '{}'::jsonb,
  versao_app  text CHECK (versao_app IS NULL OR char_length(versao_app) <= 40),
  plataforma  text NOT NULL CHECK (plataforma IN ('ios', 'android', 'web')),
  rede        text CHECK (rede IS NULL OR char_length(rede) <= 12),
  -- faixa genérica ("android-medio"), nunca modelo nem id
  aparelho    text CHECK (aparelho IS NULL OR char_length(aparelho) <= 20)
);

-- O Gabinete lê os últimos 7 dias; a limpeza apaga o que passou de 30.
CREATE INDEX IF NOT EXISTS telemetria_velocidade_criado_idx
  ON public.telemetria_velocidade (ambiente, criado_em);

-- ---------------------------------------------------------------------
-- Tranca: só o motor (chave secreta) escreve e lê. RLS ligada sem policy =
-- ninguém de fora passa (mesmo padrão das 049/053/054).
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.telemetria_velocidade ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telemetria_velocidade FROM PUBLIC;
REVOKE ALL ON TABLE public.telemetria_velocidade FROM anon, authenticated;
GRANT ALL ON TABLE public.telemetria_velocidade TO service_role;
REVOKE ALL ON SEQUENCE public.telemetria_velocidade_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.telemetria_velocidade_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.telemetria_velocidade_id_seq TO service_role;

-- ---------------------------------------------------------------------
-- Resumo para a aba Velocidade (GET /api/super/gabinete/velocidade). O
-- PostgREST não faz percentil; a conta vive aqui, e o motor recebe pronto.
-- p50/p95 por tela + plataforma + versão, e as 5 rotas com o pior p95
-- (só rotas com pelo menos 3 medições: uma chamada azarada não é ranking).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.telemetria_velocidade_resumo(p_dias integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT tela, ms_util, chamadas, plataforma, coalesce(versao_app, '?') AS versao_app
      FROM public.telemetria_velocidade
     WHERE ambiente = 'producao'
       AND criado_em >= now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 30)))
  ),
  por_tela AS (
    SELECT tela, plataforma, versao_app,
           count(*)::int AS n,
           round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms_util))::int AS p50,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms_util))::int AS p95
      FROM base
     GROUP BY tela, plataforma, versao_app
  ),
  chamada AS (
    SELECT c.key AS rota, (c.value->>'ms')::int AS ms
      FROM base, jsonb_each(base.chamadas) AS c
     WHERE jsonb_typeof(c.value) = 'object' AND (c.value->>'ms') ~ '^[0-9]+$'
  ),
  por_rota AS (
    SELECT rota,
           count(*)::int AS n,
           round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms))::int AS p50,
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int AS p95
      FROM chamada
     GROUP BY rota
  )
  SELECT jsonb_build_object(
    'dias', greatest(1, least(coalesce(p_dias, 7), 30)),
    'medicoes', (SELECT count(*) FROM base),
    'por_tela', coalesce((SELECT jsonb_agg(t ORDER BY t.tela, t.plataforma, t.versao_app) FROM por_tela t), '[]'::jsonb),
    'rotas_lentas', coalesce((SELECT jsonb_agg(r) FROM (SELECT * FROM por_rota WHERE n >= 3 ORDER BY p95 DESC, n DESC LIMIT 5) r), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.telemetria_velocidade_resumo(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telemetria_velocidade_resumo(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telemetria_velocidade_resumo(integer) TO service_role;

-- ---------------------------------------------------------------------
-- Retenção de 30 dias: o motor apaga o que passou disso, de carona na gravação,
-- no máximo a cada 6 h por instância (routes/telemetria.js → utils/telemetria.js).
-- Se um dia o pg_cron estiver ligado no projeto, o mesmo trabalho pode morar lá:
--   select cron.schedule('telemetria-30-dias', '15 4 * * *',
--     $$delete from public.telemetria_velocidade where criado_em < now() - interval '30 days'$$);
-- ---------------------------------------------------------------------

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER:
--   select count(*) from public.telemetria_velocidade;                  -- 0 (ou o que já chegou)
--   select public.telemetria_velocidade_resumo(7);                      -- {"dias":7,"medicoes":0,...}
--   select has_table_privilege('anon', 'public.telemetria_velocidade', 'insert');  -- false
-- Reversão:
--   drop function if exists public.telemetria_velocidade_resumo(integer);
--   drop table if exists public.telemetria_velocidade;
-- =====================================================================
