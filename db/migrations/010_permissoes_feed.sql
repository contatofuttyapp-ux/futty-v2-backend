-- =====================================================================
-- Futty v2.0 — Migração 010: permissões de feed por membro de equipa
-- Adiciona team_members.pode_postar; admins ficam true por defeito.
-- Idempotente.
-- =====================================================================

alter table public.team_members
  add column if not exists pode_postar boolean not null default false;

-- Admins podem postar por defeito (actualiza os existentes)
update public.team_members set pode_postar = true where role = 'admin';
