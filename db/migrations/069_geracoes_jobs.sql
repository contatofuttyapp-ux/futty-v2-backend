-- =====================================================================
-- Futty v2.0 — Migração 069: pintura da figurinha em segundo plano
-- (Rodada 29B, bloco 2, parte A, 1-out). Idempotente. ⚠️ Correr
-- manualmente no SQL Editor do Supabase (DDL é do utilizador) — junto com
-- as demais pendentes (064–069), no dia do "publica".
--
-- POR QUÊ: a geração da figurinha segurava o pedido HTTP por ~45 s (~90 s
-- com o retry da cabeça cortada) e a Cloudflare corta um pedido aos 100 s.
-- Agora POST /api/me/avatar/ai devolve na hora `{ jobId, estimativaSegundos }`
-- e a pintura roda numa fila em memória do próprio processo; esta tabela é o
-- REGISTRO de cada pintura — é por ela que GET /api/figurinha/job/:id responde
-- (mesmo depois de um reinício) e de onde sai a mediana da duração das últimas
-- 50 gerações (a barra de progresso honesta do app).
--
-- O QUE GUARDA: quem pediu (`user_id`), em que pé está (`estado`: na_fila,
-- em_andamento, pronta, falhou; `etapa`: preparando, pintando, acabamento,
-- pronta), o uniforme (`kit_id`), quando começou/acabou, `duracao_ms` (da
-- pintura de fato — da hora em que o trabalho começa até a figurinha gravada),
-- o erro em linguagem de gente (`erro`, `erro_codigo`, `erro_status`) e a
-- `avatar_url` pronta. `atualizado_em` é o BATIMENTO: o processo que pinta o
-- renova a cada ~10 s; uma pintura "em andamento" sem batimento há mais de
-- 60 s é de um processo que morreu (reinício, deploy) — vira 'falhou' com a
-- mensagem "interrompida, nada foi cobrado", porque o direito só é debitado
-- depois de a figurinha existir.
--
-- Quem lê e escreve é só o motor (chave secreta): RLS ligada, sem policy.
--
-- SEM esta migração o motor continua pintando (a fila vive em memória) e
-- responde ao app normalmente; só perde o que sobrevive a um reinício e a
-- mediana vem do que o processo viu desde que subiu (45 s se nada).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.geracoes_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  estado        text NOT NULL DEFAULT 'na_fila'
                CHECK (estado IN ('na_fila', 'em_andamento', 'pronta', 'falhou')),
  etapa         text NOT NULL DEFAULT 'preparando'
                CHECK (etapa IN ('preparando', 'pintando', 'acabamento', 'pronta')),
  kit_id        text,
  estimativa_s  integer,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  iniciado_em   timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  terminado_em  timestamptz,
  duracao_ms    integer,
  erro          text,
  erro_codigo   text,
  erro_status   integer,
  avatar_url    text
);

-- "Esta pessoa já tem uma pintura em curso?" (uma por vez por usuário) e
-- "qual foi a última dela".
CREATE INDEX IF NOT EXISTS geracoes_jobs_user_idx
  ON public.geracoes_jobs (user_id, criado_em DESC);

-- A mediana das últimas 50 prontas e a varredura das interrompidas.
CREATE INDEX IF NOT EXISTS geracoes_jobs_estado_idx
  ON public.geracoes_jobs (estado, terminado_em DESC);

-- ---------------------------------------------------------------------
-- Tranca: só o motor (chave secreta) escreve e lê (mesmo padrão da 061).
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.geracoes_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.geracoes_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.geracoes_jobs FROM anon, authenticated;
GRANT ALL ON TABLE public.geracoes_jobs TO service_role;

-- =====================================================================
-- Reversão:
-- DROP TABLE IF EXISTS public.geracoes_jobs;
-- =====================================================================
