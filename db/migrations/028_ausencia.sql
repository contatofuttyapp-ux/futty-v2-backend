-- =====================================================================
-- Futty v2.0 — Migração 028: ausência antecipada ao próximo jogo.
-- O jogador declara proactivamente que não vai ao próximo jogo. Resetado
-- quando um resultado é registado (o jogo passou).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS ausente_proximo BOOLEAN DEFAULT false;
