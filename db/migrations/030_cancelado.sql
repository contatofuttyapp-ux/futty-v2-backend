-- =====================================================================
-- Futty v2.0 — Migração 030: cancelamento de jogo com motivo.
-- Complementa o status='cancelado'/cancelado_at já existentes com uma flag
-- booleana explícita e o motivo do cancelamento (para mostrar aos membros).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS cancelado BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;
