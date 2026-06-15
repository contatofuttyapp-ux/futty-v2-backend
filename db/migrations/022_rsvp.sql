-- =====================================================================
-- Futty v2.0 — Migração 022: RSVP (confirmação de presença com prazo)
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

-- Prazo e estado do RSVP no jogo.
ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS rsvp_aberto boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS rsvp_prazo timestamptz,
  ADD COLUMN IF NOT EXISTS rsvp_fechado boolean DEFAULT false;

-- Respostas dos jogadores (uma por jogo+jogador).
CREATE TABLE IF NOT EXISTS public.rsvp_respostas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES public.games (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('confirmado', 'recusado')),
  respondido_em timestamptz DEFAULT now(),
  UNIQUE (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rsvp_game ON public.rsvp_respostas (game_id);
