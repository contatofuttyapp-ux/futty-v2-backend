-- =====================================================================
-- Futty v2.0 — Migração 018: preferências da figurinha
-- Cor do frame e fundo escolhidos na Figurinha, aplicados em todo o app.
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS cor_frame text
  DEFAULT 'dourado'
  CHECK (cor_frame IN ('dourado','verde','roxo','branco'));

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS fundo_figurinha text
  DEFAULT 'estadio'
  CHECK (fundo_figurinha IN ('estadio','gradiente','preto'));
