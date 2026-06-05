-- =====================================================================
-- Futty v2.0 — Migração 007: comentarios + comentario_anexos
-- parent_type: 'game' | 'post' (id genérico, validado no backend).
-- Idempotente. FKs de autor para public.users.
-- =====================================================================

-- Comentários em jogos ou posts editoriais
create table if not exists public.comentarios (
  id                  uuid primary key default gen_random_uuid(),
  parent_type         text not null check (parent_type in ('game', 'post')),
  parent_id           uuid not null,
  author_id           uuid not null references public.users (id) on delete cascade,
  body                text not null check (char_length(body) <= 500),
  reply_to            uuid references public.comentarios (id) on delete set null,
  -- IDs dos utilizadores mencionados (@nome) extraídos do body
  mentioned_user_ids  uuid[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

-- Anexos de comentários (imagens, GIFs)
create table if not exists public.comentario_anexos (
  id            uuid primary key default gen_random_uuid(),
  comentario_id uuid not null references public.comentarios (id) on delete cascade,
  url           text not null,
  media_type    text not null check (media_type in ('image', 'gif')),
  position      int  not null default 0,
  created_at    timestamptz not null default now()
);

-- Índices
create index if not exists idx_comentarios_parent     on public.comentarios (parent_type, parent_id);
create index if not exists idx_comentarios_reply_to    on public.comentarios (reply_to);
create index if not exists idx_comentarios_created_at  on public.comentarios (created_at desc);
create index if not exists idx_comentario_anexos_com   on public.comentario_anexos (comentario_id);

-- =====================================================================
-- RLS — acesso mediado pelo backend (service_role). Sem política
-- permissiva: parent_type ('game'|'post') exige resolver a equipa do
-- parent, o que será feito nos endpoints (Parte 2). RLS ativa fecha o
-- acesso directo via PostgREST.
-- =====================================================================
alter table public.comentarios       enable row level security;
alter table public.comentario_anexos enable row level security;

grant all privileges on public.comentarios       to service_role;
grant all privileges on public.comentario_anexos to service_role;
