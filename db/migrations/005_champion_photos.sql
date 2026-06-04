-- =====================================================================
-- Futty v2.0 — Migração 005: estatísticas dos jogadores + fotos de campeão
-- =====================================================================

-- Stats por jogador na equipa
alter table public.team_members add column if not exists gols       integer not null default 0;
alter table public.team_members add column if not exists artilharia integer not null default 0;
alter table public.team_members add column if not exists vitorias   integer not null default 0;
alter table public.team_members add column if not exists destaque   integer not null default 0;

-- Fotos da galeria do jogador (tipo: vitoria | artilharia | destaque)
create table if not exists public.champion_photos (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  url         text not null,
  tipo        text not null default 'vitoria' check (tipo in ('vitoria', 'artilharia', 'destaque')),
  created_at  timestamptz not null default now()
);
alter table public.champion_photos add column if not exists tipo text not null default 'vitoria';
create index if not exists idx_champion_photos_user on public.champion_photos (user_id, team_id);

alter table public.champion_photos enable row level security;
drop policy if exists "champion_photos_select_member" on public.champion_photos;
create policy "champion_photos_select_member" on public.champion_photos for select
  using (public.is_team_member(team_id));

grant all privileges on public.champion_photos to service_role;
