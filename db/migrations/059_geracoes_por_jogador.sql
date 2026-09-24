-- =====================================================================
-- Futty v2.0 — Migração 059: gerações por jogador no pacote do time
-- (Rodada 21, 24-set). Idempotente. ⚠️ Correr manualmente no SQL Editor do
-- Supabase (DDL é do utilizador).
--
-- POR QUÊ (decisão do dono, 24-set): o pacote do time passa a dar 3 gerações
-- por jogador (fazer, refazer, refazer de novo), não 1. `brilhantes_time` tinha
-- uma linha por (team_id, user_id) que significava "já gerou"; agora a linha
-- conta quantas vezes gerou. Direito = linha ausente OU
-- geracoes < teams.brilhante_por_jogador. Pior caso (25 × 3 = 75 gerações,
-- R$45) dá −R$2,60 no Brasil e +€5,24 na UE; caso real (~40% usado) ~57%
-- de margem — aceito pelo dono ("ninguém usa até o limite").
--
-- SEM esta migração: o motor lê `geracoes` como 1 (fail-safe) e o pacote
-- continua a dar 1 por jogador, como antes — ninguém gera a mais, ninguém
-- fica sem.
-- =====================================================================

ALTER TABLE IF EXISTS public.brilhantes_time
  ADD COLUMN IF NOT EXISTS geracoes integer NOT NULL DEFAULT 1;

-- Quantas gerações cada jogador tem no pacote (3 hoje; fica por time para o
-- Gabinete poder dar mais a um time sem mexer em código).
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_por_jogador integer NOT NULL DEFAULT 3;

-- A primeira versão desta migração (mesmo dia, horas antes) nasceu com 2:
-- as duas linhas abaixo corrigem quem a aplicou nessa forma. Inofensivas
-- para quem aplica esta versão direto.
ALTER TABLE IF EXISTS public.teams
  ALTER COLUMN brilhante_por_jogador SET DEFAULT 3;
UPDATE public.teams SET brilhante_por_jogador = 3 WHERE brilhante_por_jogador = 2;

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.teams DROP COLUMN IF EXISTS brilhante_por_jogador;
-- ALTER TABLE IF EXISTS public.brilhantes_time DROP COLUMN IF EXISTS geracoes;
-- =====================================================================
