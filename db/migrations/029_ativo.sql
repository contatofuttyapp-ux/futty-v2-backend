-- =====================================================================
-- Futty v2.0 — Migração 029: jogadores activos vs inactivos.
-- Inactivos: preservados no histórico mas excluídos do sorteio e do ranking.
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true;
