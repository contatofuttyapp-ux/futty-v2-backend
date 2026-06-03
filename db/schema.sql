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
-- status: 'agendado' | 'em_curso' | 'terminado' | 'cancelado'
-- ---------------------------------------------------------------------
create table if not exists public.games (
  id                  uuid primary key default gen_random_uuid(),
  team_id             uuid not null references public.teams (id) on delete cascade,
  data                timestamptz not null,
  local               text,
  num_times           smallint,  -- calculado no sorteio (confirmados / jogadores_por_time)
  jogadores_por_time  smallint,
  status              text not null default 'agendado'
                      check (status in ('agendado', 'em_curso', 'terminado', 'cancelado')),
  sorteio_realizado   boolean not null default false,
  times_resultado     jsonb,
  created_at          timestamptz not null default now()
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
-- TABELA: convites (Fase 4 — fluxo de convite real)
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

-- Membros da equipa veem os convites da sua equipa
create policy "convites_select_member" on public.convites for select
  using (public.is_team_member(team_id));
-- Membros podem gerar convites para a sua equipa
create policy "convites_insert_member" on public.convites for insert
  with check (public.is_team_member(team_id));
-- Admins gerem/eliminam convites
create policy "convites_update_admin" on public.convites for update
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy "convites_delete_admin" on public.convites for delete
  using (public.is_team_admin(team_id));

-- O backend usa a service_role (faz bypass da RLS) mas precisa do GRANT
grant all privileges on public.convites to service_role;

-- =====================================================================
-- FASE 5 — Sorteio de times
-- =====================================================================

-- Migração da tabela games para BDs já existentes (idempotente)
alter table public.games add column if not exists num_times          smallint;
alter table public.games add column if not exists jogadores_por_time smallint;
alter table public.games add column if not exists sorteio_realizado  boolean not null default false;
alter table public.games add column if not exists times_resultado    jsonb;

-- num_times passou a ser calculado no sorteio: torna-o opcional e remove a constraint de intervalo
alter table public.games alter column num_times drop not null;
alter table public.games alter column num_times drop default;
alter table public.games drop constraint if exists games_num_times_check;

-- Ajusta a constraint de status (agendado/em_curso/terminado/cancelado)
alter table public.games drop constraint if exists games_status_check;
alter table public.games add constraint games_status_check
  check (status in ('agendado', 'em_curso', 'terminado', 'cancelado'));

-- ---------------------------------------------------------------------
-- TABELA: game_players — jogadores confirmados num jogo
-- ---------------------------------------------------------------------
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

-- Função auxiliar: o jogo pertence a uma equipa de que sou membro/admin?
create or replace function public.is_game_member(_game_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.is_team_member((select team_id from public.games g where g.id = _game_id));
$$;

create or replace function public.is_game_admin(_game_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.is_team_admin((select team_id from public.games g where g.id = _game_id));
$$;

drop policy if exists "game_players_select_member" on public.game_players;
drop policy if exists "game_players_insert_self"   on public.game_players;
drop policy if exists "game_players_update_self"   on public.game_players;
drop policy if exists "game_players_delete_self"   on public.game_players;

-- Membros da equipa veem os jogadores do jogo
create policy "game_players_select_member" on public.game_players for select
  using (public.is_game_member(game_id));
-- Cada um confirma-se a si próprio; admin pode gerir
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

-- =====================================================================
-- FASE 6 — Votos, ranking e sorteio inteligente
-- =====================================================================

-- votes: liga o voto a um jogo; passa a "um voto por jogo" (de->para->game)
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

-- =====================================================================
-- FIM
-- =====================================================================
