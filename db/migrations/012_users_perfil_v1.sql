-- =====================================================================
-- Futty v2.0 — Migração 012: campos de perfil do jogador em users
-- Suporta a migração de dados V1 → V2 (nome_jogador + cor_preferida).
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists nome_jogador  text,
  add column if not exists cor_preferida text;

-- Restringe cor_preferida às 4 cores (permite null).
alter table public.users drop constraint if exists users_cor_preferida_check;
alter table public.users add constraint users_cor_preferida_check
  check (cor_preferida is null or cor_preferida in ('verde', 'azul', 'vermelho', 'preto'));
