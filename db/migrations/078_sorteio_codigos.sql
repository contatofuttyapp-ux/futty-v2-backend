-- =====================================================================
-- Futty v2.0 — Migração 078: link curto do sorteio (Rodada 29I, bloco 3,
-- item 74 da Rodada 29). Idempotente e aditiva. ⚠️ Correr manualmente no SQL
-- Editor do Supabase (DDL é do utilizador) — junto com a 076, a 077 e a 079.
--
-- POR QUÊ: o link do sorteio que vai para o grupo era
-- futtyapp.com.br/p/<slug do time>/<uuid de 36 caracteres> — comprido e feio
-- no WhatsApp. Passa a existir futtyapp.com.br/s/<código de 8 letras e
-- números>, no MESMO molde do link curto do convite (/c/<código>, migração
-- 072): uma tabela de códigos, um por jogo, apontando para o jogo. O link
-- longo (/p/<slug>/<id>) continua valendo, igual.
--
-- Alfabeto do código (minúsculas, sem 0/o/1/l/i, que se confundem):
-- 23456789 abcdefghjkmnpqrstuvwxyz — 31 símbolos, 8 posições (~8,5 × 10^11),
-- o mesmo do convite (utils/conviteCodigo.js).
--
-- SEM esta migração: o motor segue funcionando — o "Copiar link do sorteio"
-- leva o link longo (/p/…), como antes, e /s/<código> responde "este sorteio
-- não existe".
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.sorteio_codigos (
  codigo    text PRIMARY KEY CHECK (codigo ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{6,8}$'),
  game_id   uuid NOT NULL UNIQUE REFERENCES public.games(id) ON DELETE CASCADE,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Só o motor (service role) lê e escreve; o app passa sempre por ele.
ALTER TABLE public.sorteio_codigos ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- Reversão:
-- DROP TABLE IF EXISTS public.sorteio_codigos;
-- =====================================================================
