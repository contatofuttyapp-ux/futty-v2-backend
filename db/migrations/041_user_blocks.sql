-- 041_user_blocks.sql — Bloqueio entre jogadores (exigência Apple App Store
-- Review Guidelines §1.2, apps com conteúdo gerado por utilizador).
-- Bloquear é sempre do próprio; a Resenha filtra os DOIS lados da relação
-- (quem bloqueei E quem me bloqueou), silenciosamente — nunca notifica.
-- DDL "à mão", como o resto do projeto — correr no Supabase.

create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_blocks_no_self check (blocker_id <> blocked_id),
  constraint user_blocks_unique unique (blocker_id, blocked_id)
);

create index if not exists user_blocks_blocker_idx on public.user_blocks (blocker_id);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);
