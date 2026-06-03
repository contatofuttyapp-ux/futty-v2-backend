-- =====================================================================
-- Futty v2.0 — Fase 6: votos, ranking e sorteio inteligente
-- Como usar:
--   Supabase Dashboard -> SQL Editor -> New query -> cola este ficheiro -> Run
-- Idempotente (seguro de re-executar).
-- =====================================================================

-- votes: liga o voto a um jogo; "um voto por jogo" (de_user -> para_user -> game)
alter table public.votes add column if not exists game_id uuid references public.games (id) on delete cascade;
alter table public.votes drop constraint if exists votes_de_user_id_para_user_id_team_id_key;
alter table public.votes drop constraint if exists votes_unique_por_jogo;
alter table public.votes add constraint votes_unique_por_jogo
  unique (de_user_id, para_user_id, game_id);
create index if not exists idx_votes_game on public.votes (game_id);

-- game_players: marcação de cabeça de chave (goleiro já existe)
alter table public.game_players add column if not exists cabeca_chave boolean not null default false;

-- O backend usa a service_role (faz bypass da RLS) mas precisa do GRANT
grant all privileges on public.votes to service_role;
