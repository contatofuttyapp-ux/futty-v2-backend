-- =====================================================================
-- Futty v2.0 — Migração 014: explorar equipas públicas + pedidos de entrada
-- Idempotente.
-- =====================================================================

-- Campos novos em teams
alter table public.teams
  add column if not exists publica     boolean not null default false,
  add column if not exists localizacao text,
  add column if not exists descricao   text;

alter table public.teams drop constraint if exists teams_localizacao_check;
alter table public.teams add constraint teams_localizacao_check
  check (localizacao is null or char_length(localizacao) <= 100);

alter table public.teams drop constraint if exists teams_descricao_check;
alter table public.teams add constraint teams_descricao_check
  check (descricao is null or char_length(descricao) <= 300);

-- Pedidos de entrada em equipas
create table if not exists public.team_join_requests (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  mensagem    text check (mensagem is null or char_length(mensagem) <= 300),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (team_id, user_id)
);

create index if not exists idx_team_join_requests_team   on public.team_join_requests (team_id);
create index if not exists idx_team_join_requests_user   on public.team_join_requests (user_id);
create index if not exists idx_team_join_requests_status on public.team_join_requests (status);

-- RLS — acesso mediado pelo backend (service_role).
alter table public.team_join_requests enable row level security;
grant all privileges on public.team_join_requests to service_role;
