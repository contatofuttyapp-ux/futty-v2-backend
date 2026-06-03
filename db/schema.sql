-- =====================================================================
-- Futty v2.0 — Schema da base de dados (Supabase / PostgreSQL)
-- =====================================================================
-- Como usar:
--   Supabase Dashboard -> SQL Editor -> New query -> cola este ficheiro -> Run
-- Seguro de re-executar (idempotente): usa IF NOT EXISTS / DROP POLICY IF EXISTS.
-- =====================================================================

-- Extensão para gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- TABELA: users
-- Espelha auth.users. O id deve ser igual ao id em auth.users.
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text unique not null,
  nome        text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- TABELA: teams
-- ---------------------------------------------------------------------
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  slug        text unique not null,
  cor         text not null default 'verde' check (cor in ('verde', 'azul', 'vermelho', 'preto')),
  criado_por  uuid not null references public.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Migração para tabelas já existentes (adiciona a coluna cor se faltar)
alter table public.teams add column if not exists cor text not null default 'verde';

-- ---------------------------------------------------------------------
-- TABELA: team_members
-- role: 'admin' | 'member'
-- ---------------------------------------------------------------------
create table if not exists public.team_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  team_id     uuid not null references public.teams (id) on delete cascade,
  role        text not null default 'member' check (role in ('admin', 'member')),
  created_at  timestamptz not null default now(),
  unique (user_id, team_id)
);

-- ---------------------------------------------------------------------
-- TABELA: games
-- status: 'agendado' | 'a_decorrer' | 'terminado' | 'cancelado'
-- ---------------------------------------------------------------------
create table if not exists public.games (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  data        timestamptz not null,
  local       text,
  status      text not null default 'agendado'
              check (status in ('agendado', 'a_decorrer', 'terminado', 'cancelado')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- TABELA: votes
-- nota: 1 a 5. Um voto por (de_user_id, para_user_id, team_id).
-- ---------------------------------------------------------------------
create table if not exists public.votes (
  id            uuid primary key default gen_random_uuid(),
  de_user_id    uuid not null references public.users (id) on delete cascade,
  para_user_id  uuid not null references public.users (id) on delete cascade,
  team_id       uuid not null references public.teams (id) on delete cascade,
  nota          smallint not null check (nota between 1 and 5),
  created_at    timestamptz not null default now(),
  unique (de_user_id, para_user_id, team_id)
);

-- Índices úteis
create index if not exists idx_team_members_team   on public.team_members (team_id);
create index if not exists idx_team_members_user   on public.team_members (user_id);
create index if not exists idx_games_team          on public.games (team_id);
create index if not exists idx_votes_team          on public.votes (team_id);
create index if not exists idx_votes_para_user     on public.votes (para_user_id);

-- =====================================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================================
alter table public.users        enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.games        enable row level security;
alter table public.votes        enable row level security;

-- Função auxiliar: é o utilizador membro desta equipa?
create or replace function public.is_team_member(_team_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = _team_id and tm.user_id = auth.uid()
  );
$$;

-- Função auxiliar: é admin desta equipa?
create or replace function public.is_team_admin(_team_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = _team_id and tm.user_id = auth.uid() and tm.role = 'admin'
  );
$$;

-- ---------------- POLICIES: users ----------------
drop policy if exists "users_select_all"  on public.users;
drop policy if exists "users_insert_self" on public.users;
drop policy if exists "users_update_self" on public.users;

create policy "users_select_all"  on public.users for select using (true);
create policy "users_insert_self" on public.users for insert with check (auth.uid() = id);
create policy "users_update_self" on public.users for update using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------- POLICIES: teams ----------------
drop policy if exists "teams_select_member" on public.teams;
drop policy if exists "teams_insert_owner"  on public.teams;
drop policy if exists "teams_update_admin"  on public.teams;
drop policy if exists "teams_delete_admin"  on public.teams;

-- Ver equipas de que sou membro (ou que criei)
create policy "teams_select_member" on public.teams for select
  using (criado_por = auth.uid() or public.is_team_member(id));
create policy "teams_insert_owner" on public.teams for insert
  with check (criado_por = auth.uid());
create policy "teams_update_admin" on public.teams for update
  using (public.is_team_admin(id)) with check (public.is_team_admin(id));
create policy "teams_delete_admin" on public.teams for delete
  using (criado_por = auth.uid());

-- ---------------- POLICIES: team_members ----------------
drop policy if exists "members_select_team"  on public.team_members;
drop policy if exists "members_insert_self"  on public.team_members;
drop policy if exists "members_manage_admin" on public.team_members;
drop policy if exists "members_delete"       on public.team_members;

-- Ver membros das equipas a que pertenço
create policy "members_select_team" on public.team_members for select
  using (user_id = auth.uid() or public.is_team_member(team_id));
-- Entrar numa equipa (inserir-se a si próprio) ou admin a adicionar
create policy "members_insert_self" on public.team_members for insert
  with check (user_id = auth.uid() or public.is_team_admin(team_id));
-- Admin gere roles
create policy "members_manage_admin" on public.team_members for update
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
-- Sair da equipa (próprio) ou admin remove
create policy "members_delete" on public.team_members for delete
  using (user_id = auth.uid() or public.is_team_admin(team_id));

-- ---------------- POLICIES: games ----------------
drop policy if exists "games_select_member" on public.games;
drop policy if exists "games_insert_admin"  on public.games;
drop policy if exists "games_update_admin"  on public.games;
drop policy if exists "games_delete_admin"  on public.games;

create policy "games_select_member" on public.games for select
  using (public.is_team_member(team_id));
create policy "games_insert_admin" on public.games for insert
  with check (public.is_team_admin(team_id));
create policy "games_update_admin" on public.games for update
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy "games_delete_admin" on public.games for delete
  using (public.is_team_admin(team_id));

-- ---------------- POLICIES: votes ----------------
drop policy if exists "votes_select_member" on public.votes;
drop policy if exists "votes_insert_self"   on public.votes;
drop policy if exists "votes_update_self"   on public.votes;
drop policy if exists "votes_delete_self"   on public.votes;

-- Membros veem os votos da equipa
create policy "votes_select_member" on public.votes for select
  using (public.is_team_member(team_id));
-- Só posso votar em meu nome e na equipa de que sou membro
create policy "votes_insert_self" on public.votes for insert
  with check (de_user_id = auth.uid() and public.is_team_member(team_id));
create policy "votes_update_self" on public.votes for update
  using (de_user_id = auth.uid()) with check (de_user_id = auth.uid());
create policy "votes_delete_self" on public.votes for delete
  using (de_user_id = auth.uid());

-- =====================================================================
-- TRIGGER: cria automaticamente uma linha em public.users
-- quando um utilizador se regista no Supabase Auth.
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, nome, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nome', new.raw_user_meta_data ->> 'full_name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- FIM
-- =====================================================================
