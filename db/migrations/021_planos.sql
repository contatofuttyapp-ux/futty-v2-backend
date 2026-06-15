-- =====================================================================
-- Futty v2.0 — Migração 021: planos (free/pro/elite) e quota de avatar IA
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free'
  CHECK (plan IN ('free', 'pro', 'elite'));

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS avatar_ia_mes integer DEFAULT 0;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS avatar_ia_reset date DEFAULT CURRENT_DATE;
