-- =====================================================================
-- Futty v2.0 — Migração 025: foto_url (foto real separada do avatar IA)
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS foto_url text;

-- Backfill: quem já tem avatar passa a ter essa foto como foto original.
UPDATE public.users
  SET foto_url = avatar_url
  WHERE avatar_url IS NOT NULL
    AND foto_url IS NULL;
