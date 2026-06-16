-- =====================================================================
-- Futty v2.0 — Migração 026: campeonato / torneio (2 times fixos + jornadas)
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.campeonatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  nome text NOT NULL,
  num_jornadas int NOT NULL DEFAULT 8,
  jornadas_jogadas int DEFAULT 0,
  estado text DEFAULT 'ativo' CHECK (estado IN ('ativo', 'terminado')),
  time_a_nome text DEFAULT 'Time A',
  time_b_nome text DEFAULT 'Time B',
  time_a_pontos int DEFAULT 0,
  time_b_pontos int DEFAULT 0,
  time_a_vitorias int DEFAULT 0,
  time_b_vitorias int DEFAULT 0,
  time_a_empates int DEFAULT 0,
  time_b_empates int DEFAULT 0,
  time_a_derrotas int DEFAULT 0,
  time_b_derrotas int DEFAULT 0,
  campeao text CHECK (campeao IN ('A', 'B', 'empate')),
  criado_em timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campeonato_jornadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campeonato_id uuid NOT NULL REFERENCES public.campeonatos (id) ON DELETE CASCADE,
  game_id uuid REFERENCES public.games (id),
  numero int NOT NULL,
  vencedor text CHECK (vencedor IN ('A', 'B', 'empate')),
  placar_a int,
  placar_b int,
  data timestamptz DEFAULT now(),
  UNIQUE (campeonato_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_campeonatos_team ON public.campeonatos (team_id);
CREATE INDEX IF NOT EXISTS idx_jornadas_camp ON public.campeonato_jornadas (campeonato_id);
