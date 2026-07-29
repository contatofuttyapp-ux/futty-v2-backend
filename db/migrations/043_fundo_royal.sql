-- Futty v2.0 — Migração 043: adiciona 'royal' aos fundos permitidos da Figurinha.
-- ROYAL é o par de luxo do GOLDEN (chapa roxa da casa), aprovado pelo dono. O CHECK
-- de users.fundo_figurinha (migração 018, alargado depois para golden/aura sem
-- migração própria) precisa incluir 'royal' antes do PATCH /api/me aceitar o valor.
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_fundo_figurinha_check;
ALTER TABLE public.users ADD CONSTRAINT users_fundo_figurinha_check
  CHECK (fundo_figurinha IN ('estadio', 'gradiente', 'aura', 'preto', 'golden', 'royal'));
