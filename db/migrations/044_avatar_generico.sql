-- Futty v2.0 — Migração 044: escolha do avatar genérico (31-jul, ordem do dono).
-- users.avatar_generico guarda a escolha EXPLÍCITA da pessoa entre os 6 genéricos
-- da casa (masc m1-m3, fem f1-f3) — o app não pergunta sexo, ela escolhe o visual.
-- NULL = ainda não escolheu → rodízio por hash do id (masculino), comportamento atual.
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS avatar_generico text
  DEFAULT NULL
  CHECK (avatar_generico IN ('m1','m2','m3','f1','f2','f3'));
