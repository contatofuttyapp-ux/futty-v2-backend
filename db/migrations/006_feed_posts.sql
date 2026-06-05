-- =====================================================================
-- Futty v2.0 — Migração 006: feed_posts (posts editoriais da Resenha)
-- Tabelas: feed_posts, feed_post_media. Idempotente.
-- FKs para public.users (convenção do schema; backend lê nome/avatar daí).
-- =====================================================================

-- Posts editoriais criados pelo admin ou membros autorizados (pode_postar)
create table if not exists public.feed_posts (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  author_id   uuid not null references public.users (id) on delete cascade,
  body        text not null check (char_length(body) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Anexos de posts (imagens, GIFs, vídeos)
create table if not exists public.feed_post_media (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.feed_posts (id) on delete cascade,
  url         text not null,
  media_type  text not null check (media_type in ('image', 'gif', 'video')),
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);

-- Índices
create index if not exists idx_feed_posts_team       on public.feed_posts (team_id);
create index if not exists idx_feed_posts_created_at  on public.feed_posts (created_at desc);
create index if not exists idx_feed_post_media_post   on public.feed_post_media (post_id);

-- =====================================================================
-- RLS — leitura para membros da equipa; escrita só via service_role (backend)
-- =====================================================================
alter table public.feed_posts      enable row level security;
alter table public.feed_post_media enable row level security;

drop policy if exists "feed_posts_select_member" on public.feed_posts;
create policy "feed_posts_select_member" on public.feed_posts for select
  using (public.is_team_member(team_id));

drop policy if exists "feed_post_media_select_member" on public.feed_post_media;
create policy "feed_post_media_select_member" on public.feed_post_media for select
  using (public.is_team_member((select team_id from public.feed_posts p where p.id = post_id)));

grant all privileges on public.feed_posts      to service_role;
grant all privileges on public.feed_post_media to service_role;
