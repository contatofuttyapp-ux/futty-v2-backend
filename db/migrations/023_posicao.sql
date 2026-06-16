-- =====================================================================
-- Futty v2.0 — Migração 023: posição do jogador por equipa
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS posicao text
  CHECK (posicao IN ('GL', 'DEF', 'MEI', 'ATA'));
