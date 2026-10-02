-- =====================================================================
-- Futty v2.0 — Migração 072: link curto do convite (Rodada 29H, item 7,
-- 2-out). Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase
-- (DDL é do utilizador) — junto com as demais pendentes, no dia do "publica".
--
-- POR QUÊ (dono, 2-out): o link do convite era futtyapp.com.br/convite/<uuid
-- de 36 caracteres> — comprido, feio no grupo do WhatsApp e difícil de ditar.
-- Passa a existir também futtyapp.com.br/c/<código de 8 letras e números>.
--
-- O QUE FAZ: uma tabela de códigos, um por convite. O código aponta para o
-- convite (convite_id), então vale o MESMO prazo (convites.expires_at) e some
-- junto quando o admin revoga o convite (ON DELETE CASCADE). O link longo
-- (/convite/<uuid>) continua válido e igual: o código é só outro jeito de
-- chegar ao mesmo convite (utils/conviteCodigo.js: o motor aceita os dois no
-- GET /api/convite/:token e no POST /api/convite/:token/aceitar).
--
-- Alfabeto do código (minúsculas, sem 0/o/1/l/i, que se confundem):
-- 23456789 abcdefghjkmnpqrstuvwxyz — 31 símbolos, 8 posições (~8,5 × 10^11).
--
-- SEM esta migração: o motor segue funcionando — o convite nasce só com o
-- link longo (a resposta traz `codigo: null`) e /c/<código> responde "este
-- convite não existe".
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.convite_codigos (
  codigo     text PRIMARY KEY CHECK (codigo ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{6,8}$'),
  convite_id uuid NOT NULL UNIQUE REFERENCES public.convites(id) ON DELETE CASCADE,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- RLS/grants no padrão da 049/057/058: zero para anon/authenticated (sem
-- policy); o backend usa service_role, que ignora RLS.
ALTER TABLE IF EXISTS public.convite_codigos ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON public.convite_codigos TO service_role;

-- =====================================================================
-- Reversão (os links curtos já mandados deixam de abrir; os longos seguem):
-- DROP TABLE IF EXISTS public.convite_codigos;
-- =====================================================================
