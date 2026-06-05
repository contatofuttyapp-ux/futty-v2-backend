-- =====================================================================
-- Futty v2.0 — Migração 008: reacoes (emojis em comentários, jogos ou posts)
-- target_type: 'comentario' | 'game' | 'post'. Uma reação por user/target.
-- Idempotente. FK user_id para public.users.
-- =====================================================================

create table if not exists public.reacoes (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('comentario', 'game', 'post')),
  target_id   uuid not null,
  user_id     uuid not null references public.users (id) on delete cascade,
  emoji       text not null check (emoji in ('👍','❤️','😂','😮','😢','😡')),
  created_at  timestamptz not null default now(),
  -- cada utilizador só pode ter uma reação por target
  unique (target_type, target_id, user_id)
);

create index if not exists idx_reacoes_target on public.reacoes (target_type, target_id);

-- =====================================================================
-- RLS — acesso mediado pelo backend (service_role).
-- =====================================================================
alter table public.reacoes enable row level security;
grant all privileges on public.reacoes to service_role;
