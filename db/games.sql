-- =====================================================================
-- Futty v2.0 — Fase 5: sorteio de times (games + game_players)
-- Como usar:
--   Supabase Dashboard -> SQL Editor -> New query -> cola este ficheiro -> Run
-- Idempotente (seguro de re-executar).
-- =====================================================================

create extension if not exists "pgcrypto";

-- Novos campos na tabela games
alter table public.games add column if not exists num_times          smallint;
alter table public.games add column if not exists jogadores_por_time smallint;
alter table public.games add column if not exists sorteio_realizado  boolean not null default false;
alter table public.games add column if not exists times_resultado    jsonb;

-- num_times é calculado no sorteio: torna-o opcional e remove a constraint de intervalo
alter table public.games alter column num_times drop not null;
alter table public.games alter column num_times drop default;
alter table public.games drop constraint if exists games_num_times_check;

-- Ajusta a constraint de status (agendado/em_curso/terminado/cancelado)
alter table public.games drop constraint if exists games_status_check;
alter table public.games add constraint games_status_check
  check (status in ('agendado', 'em_curso', 'terminado', 'cancelado'));

-- Tabela game_players
create table if not exists public.game_players (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  confirmado  boolean not null default true,
  goleiro     boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (game_id, user_id)
);

create index if not exists idx_game_players_game on public.game_players (game_id);
create index if not exists idx_game_players_user on public.game_players (user_id);

-- RLS
alter table public.game_players enable row level security;

create or replace function public.is_game_member(_game_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select public.is_team_member((select team_id from public.games g where g.id = _game_id));
$$;

create or replace function public.is_game_admin(_game_id uuid)
returns boolean language sql security definer set search_path = public as $$
  select public.is_team_admin((select team_id from public.games g where g.id = _game_id));
$$;

drop policy if exists "game_players_select_member" on public.game_players;
drop policy if exists "game_players_insert_self"   on public.game_players;
drop policy if exists "game_players_update_self"   on public.game_players;
drop policy if exists "game_players_delete_self"   on public.game_players;

create policy "game_players_select_member" on public.game_players for select
  using (public.is_game_member(game_id));
create policy "game_players_insert_self" on public.game_players for insert
  with check (user_id = auth.uid() or public.is_game_admin(game_id));
create policy "game_players_update_self" on public.game_players for update
  using (user_id = auth.uid() or public.is_game_admin(game_id))
  with check (user_id = auth.uid() or public.is_game_admin(game_id));
create policy "game_players_delete_self" on public.game_players for delete
  using (user_id = auth.uid() or public.is_game_admin(game_id));

-- O backend usa a service_role (faz bypass da RLS) mas precisa do GRANT
grant all privileges on public.games        to service_role;
grant all privileges on public.game_players to service_role;
