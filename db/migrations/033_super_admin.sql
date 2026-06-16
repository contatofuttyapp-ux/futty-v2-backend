-- =====================================================================
-- Futty v2.0 — Migração 033: flag de super-admin (gestão global).
-- Permite ao Pedro gerir utilizadores/equipas por fora das equipas, sem
-- acesso direto à base de dados. O ban de contas usa o ban nativo do
-- Supabase Auth (não há coluna `banned`).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;

-- Bootstrap (correr UMA vez, com o email do Pedro) — sem isto ninguém acede a /super:
-- UPDATE public.users SET is_super_admin = true WHERE email = '<email-do-pedro>';
