-- =====================================================================
-- Futty v2.0 — Migração 013: extras de perfil (página Perfil / Fase 12)
--   • avatar_ia_creditos: créditos de geração de avatar por IA (default 3)
--   • telefone: contacto do jogador
--   • cor_preferida: passa a aceitar 6 cores (uniforme) — amarelo e cinzento
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists avatar_ia_creditos int  not null default 3,
  add column if not exists telefone           text;

-- Relaxa o check de cor_preferida para as 6 cores de uniforme.
alter table public.users drop constraint if exists users_cor_preferida_check;
alter table public.users add constraint users_cor_preferida_check
  check (cor_preferida is null or cor_preferida in
    ('verde', 'azul', 'vermelho', 'preto', 'amarelo', 'cinzento'));
