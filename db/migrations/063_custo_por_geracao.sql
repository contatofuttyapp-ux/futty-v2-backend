-- =====================================================================
-- Futty v2.0 — Migração 063: custo REAL por geração, com o time que pagou (Rodada 28, bloco H)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ (achado da Rodada 22): brilhantes_time tem UMA linha por (time, pessoa) e o custo era
-- gravado por cima a cada geração — quem refez 5 vezes aparecia no Gabinete com o custo de uma.
-- O motor passou a SOMAR na linha (total por time, já certo sem esta migração). Para o total POR
-- MÊS falta saber QUANDO cada geração aconteceu e quanto custou: o log de gerações (046) já tem uma
-- linha por geração com a hora; aqui ganha o time que pagou (pacote) e o custo real da fal.
--
-- SEM esta migração: o motor grava o log como antes (quem, IP, quando — o antiabuso segue igual) e
-- o Gabinete mostra o total por time sem a quebra por mês.
--
-- Histórico: gerações de antes desta migração não têm time nem custo no log — o mês começa a contar
-- da aplicação em diante (o total por time, esse, já soma o que a linha do pacote guardou).
-- =====================================================================

ALTER TABLE IF EXISTS public.geracao_ia_log
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS public.geracao_ia_log
  ADD COLUMN IF NOT EXISTS custo_cents integer;

-- "Quanto este time gastou em cada mês" — filtra por time, agrupa pela data.
CREATE INDEX IF NOT EXISTS idx_geracao_ia_log_team_created_at
  ON public.geracao_ia_log (team_id, created_at)
  WHERE team_id IS NOT NULL;

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 2 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'geracao_ia_log' and column_name in ('team_id', 'custo_cents');
-- Reversão:
--   drop index if exists public.idx_geracao_ia_log_team_created_at;
--   alter table public.geracao_ia_log drop column if exists custo_cents;
--   alter table public.geracao_ia_log drop column if exists team_id;
-- =====================================================================
