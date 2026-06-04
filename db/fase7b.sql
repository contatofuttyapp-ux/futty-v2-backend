-- =====================================================================
-- Futty v2.0 — Fase 7b: tipo da foto (vitoria | artilharia | destaque)
-- Como usar:
--   Supabase Dashboard -> SQL Editor -> New query -> cola este ficheiro -> Run
-- Idempotente (seguro de re-executar).
-- =====================================================================

alter table public.champion_photos
  add column if not exists tipo text not null default 'vitoria';

alter table public.champion_photos drop constraint if exists champion_photos_tipo_check;
alter table public.champion_photos add constraint champion_photos_tipo_check
  check (tipo in ('vitoria', 'artilharia', 'destaque'));
