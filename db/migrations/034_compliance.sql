-- =====================================================================
-- Futty v2.0 — Migração 034: compliance (data de nascimento / maioridade).
-- Guarda a data de nascimento para verificação de maioridade (18+), base
-- para o gating de conteúdo de apostas (item 67, pós-deploy).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
--
-- NOTA sobre is_adult: a spec pedia uma coluna GERADA STORED com
--   (CURRENT_DATE - birthdate) >= 6570. O Postgres REJEITA isso — expressões
--   de colunas geradas têm de ser IMMUTABLE e CURRENT_DATE não é (é STABLE):
--     ERROR: generation expression is not immutable
--   Além disso, STORED congelaria o valor na escrita (um menor nunca passaria
--   a adulto). Por isso is_adult é calculado em runtime no backend (GET /api/me)
--   a partir de birthdate. Aqui guardamos apenas a data.
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS birthdate DATE;
