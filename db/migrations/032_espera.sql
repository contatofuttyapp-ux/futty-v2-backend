-- =====================================================================
-- Futty v2.0 — Migração 032: lista de espera do RSVP (jogo cheio).
-- Quando um jogo atinge max_jogadores, novas confirmações entram em fila.
-- Ao libertar-se uma vaga, o primeiro da fila é promovido automaticamente.
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.rsvp_espera (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    UUID NOT NULL REFERENCES public.games (id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  posicao    INT NOT NULL,
  criado_em  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rsvp_espera_game ON public.rsvp_espera (game_id, posicao);

ALTER TABLE public.rsvp_espera ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON public.rsvp_espera TO service_role;
