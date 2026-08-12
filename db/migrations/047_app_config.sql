-- Futty v2.0 — Migração 047: configuração simples chave/valor (11-ago). Primeiro
-- uso: a flag de auto-freeze do anti-abuso de custo IA (chave 'ia_freeze', valor
-- = JSON {motivo, desde}). O Gabinete poderá ler/limpar esta tabela; por agora,
-- limpar (liberar o freeze) via SQL manual no Supabase:
--   DELETE FROM public.app_config WHERE chave = 'ia_freeze';
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

CREATE TABLE IF NOT EXISTS public.app_config (
  chave text PRIMARY KEY,
  valor text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
