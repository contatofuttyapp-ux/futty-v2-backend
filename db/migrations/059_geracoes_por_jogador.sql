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

-- Quantas gerações cada jogador tem no pacote (5 hoje; fica por time para o
-- Gabinete poder dar mais a um time sem mexer em código).
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_por_jogador integer NOT NULL DEFAULT 5;

-- Versões anteriores desta migração (mesmo dia) nasceram com 2 e depois 3;
-- o dono fixou 5 à noite (24-set): as duas linhas abaixo corrigem quem a
-- aplicou nessas formas. Inofensivas para quem aplica esta versão direto.
-- Pior caso com 5: 25 × 5 = 125 gerações = US$14 (~R$75) por time.
ALTER TABLE IF EXISTS public.teams
  ALTER COLUMN brilhante_por_jogador SET DEFAULT 5;
UPDATE public.teams SET brilhante_por_jogador = 5 WHERE brilhante_por_jogador < 5;

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.teams DROP COLUMN IF EXISTS brilhante_por_jogador;
-- ALTER TABLE IF EXISTS public.brilhantes_time DROP COLUMN IF EXISTS geracoes;
-- =====================================================================
