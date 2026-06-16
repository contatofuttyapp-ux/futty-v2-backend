-- =====================================================================
-- Futty v2.0 — Migração 024: resultado do jogo (4 níveis de detalhe)
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS resultado_nivel int DEFAULT 0
    CHECK (resultado_nivel IN (0, 1, 2, 3)),
  ADD COLUMN IF NOT EXISTS time_vencedor text
    CHECK (time_vencedor IN ('A', 'B', 'empate')),
  ADD COLUMN IF NOT EXISTS placar_a int,
  ADD COLUMN IF NOT EXISTS placar_b int;

CREATE TABLE IF NOT EXISTS public.gols_jogadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES public.games (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  time text CHECK (time IN ('A', 'B')),
  gols int DEFAULT 0,
  UNIQUE (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gols_game ON public.gols_jogadores (game_id);
