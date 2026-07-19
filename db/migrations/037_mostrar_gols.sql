-- =====================================================================
-- Futty v2.0 — Migração 037: flag teams.mostrar_gols
-- Controlo do admin (noutra página): equipa casual pode esconder gols.
-- OFF → o endpoint do ranking/jogador tira gols+artilharia das respostas
-- (radar 5→3 eixos, tile de Gols some). Default TRUE (comportamento actual).
-- DDL — correr no SQL editor do Supabase (service_role).
-- =====================================================================

alter table public.teams
  add column if not exists mostrar_gols boolean not null default true;

-- Reversão:
-- alter table public.teams drop column if exists mostrar_gols;
