-- =====================================================================
-- Futty v2.0 — Migração 036: adiciona 🍿 às reações permitidas
-- Amplia o CHECK de reacoes.emoji (era 6 emojis na migração 008) para incluir
-- a pipoca 🍿. Idempotente: dropa o CHECK auto-nomeado e recria-o.
-- DDL — correr no SQL editor do Supabase (service_role).
-- =====================================================================

alter table public.reacoes drop constraint if exists reacoes_emoji_check;

alter table public.reacoes
  add constraint reacoes_emoji_check
  check (emoji in ('👍','❤️','😂','😮','😢','😡','🍿'));
