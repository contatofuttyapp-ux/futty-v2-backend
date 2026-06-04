-- =====================================================================
-- Futty v2.0 — Migração 002: convites
-- Token único, com expiração, de uso único (usado_por != null => usado).
-- =====================================================================

create table if not exists public.convites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  token       uuid not null unique default gen_random_uuid(),
  criado_por  uuid not null references public.users (id) on delete cascade,
  usado_por   uuid references public.users (id) on delete set null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_convites_token on public.convites (token);
create index if not exists idx_convites_team  on public.convites (team_id);

alter table public.convites enable row level security;

drop policy if exists "convites_select_member" on public.convites;
drop policy if exists "convites_insert_member" on public.convites;
drop policy if exists "convites_update_admin"  on public.convites;
drop policy if exists "convites_delete_admin"  on public.convites;

create policy "convites_select_member" on public.convites for select
  using (public.is_team_member(team_id));
create policy "convites_insert_member" on public.convites for insert
  with check (public.is_team_member(team_id));
create policy "convites_update_admin" on public.convites for update
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy "convites_delete_admin" on public.convites for delete
  using (public.is_team_admin(team_id));

grant all privileges on public.convites to service_role;
