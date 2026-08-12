-- Futty v2.0 — Migração 048: hash sha256 da foto de perfil (11-ago, pacote
-- anti-abuso). Matéria-prima do sinal "N contas com a mesma foto em 24h" —
-- farms de contas costumam reciclar as mesmas fotos entre perfis.
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS foto_hash text;
CREATE INDEX IF NOT EXISTS idx_users_foto_hash ON public.users (foto_hash);
