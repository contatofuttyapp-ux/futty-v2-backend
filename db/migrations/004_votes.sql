-- =====================================================================
-- Futty v2.0 — Migração 004: votos por jogo
-- Liga cada voto a um jogo; passa a "um voto por (de_user, para_user, game)".
-- =====================================================================

alter table public.votes add column if not exists game_id uuid references public.games (id) on delete cascade;

-- Remove a unicidade antiga (por equipa) e cria a nova (por jogo)
alter table public.votes drop constraint if exists votes_de_user_id_para_user_id_team_id_key;
alter table public.votes drop constraint if exists votes_unique_por_jogo;
alter table public.votes add constraint votes_unique_por_jogo
  unique (de_user_id, para_user_id, game_id);

create index if not exists idx_votes_game on public.votes (game_id);

grant all privileges on public.votes to service_role;
