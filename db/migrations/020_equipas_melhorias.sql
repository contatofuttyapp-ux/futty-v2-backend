-- =====================================================================
-- Futty v2.0 — Migração 020: logo, cor de fundo, visibilidade e controlo de ranking
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS cor_fundo text DEFAULT '#1a1a2e'
  CHECK (char_length(cor_fundo) <= 20);

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS modo_visibilidade text
  NOT NULL DEFAULT 'privado'
  CHECK (modo_visibilidade IN
    ('privado','publico_aprovacao','publico_aberto'));

-- Backfill: equipas que já eram públicas (publica = true) passam a entrar
-- com aprovação (continuam visíveis no Explorar). As restantes ficam privadas.
UPDATE public.teams
  SET modo_visibilidade = 'publico_aprovacao'
  WHERE publica = true AND modo_visibilidade = 'privado';

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS nota_interna text
  CHECK (char_length(nota_interna) <= 200);

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS visivel_ranking boolean
  NOT NULL DEFAULT true;
