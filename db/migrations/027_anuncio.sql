-- =====================================================================
-- Futty v2.0 — Migração 027: anúncio oficial no feed (post especial do admin)
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.feed_posts
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'post'
    CHECK (tipo IN ('post', 'anuncio', 'jogo', 'voto')),
  ADD COLUMN IF NOT EXISTS conteudo jsonb;
