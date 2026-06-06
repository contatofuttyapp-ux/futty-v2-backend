-- =====================================================================
-- Futty v2.0 — Migração 017: nota mínima passa a 0.5 (meia estrela)
-- Relaxa o CHECK de votes.nota de >= 1 para >= 0.5 (incrementos de 0.5).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

alter table public.votes drop constraint if exists votes_nota_check;
alter table public.votes add constraint votes_nota_check
  check (nota >= 0.5 and nota <= 5 and mod((nota * 10)::int, 5) = 0);
