-- =====================================================================
-- Futty v2.0 — Migração 056: card_modo (Rodada 18)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase.
--
-- POR QUÊ: quando existe figurinha (IA), users.avatar_url aponta sempre
-- para ela e a pessoa não consegue mostrar a própria foto no card. O
-- interruptor "Mostrar minha foto" / "Mostrar minha figurinha"
-- (PUT /api/me/avatar/modo) grava a escolha aqui para ela sobreviver a
-- trocas de foto: no modo 'foto', trocar a foto atualiza o card; no modo
-- 'figurinha', a troca de foto não derruba a figurinha (comportamento de
-- sempre — routes/auth.js, POST /api/me/avatar).
--
-- SEM esta migração aplicada: o interruptor continua a funcionar na hora
-- (avatar_url troca igual) mas a escolha NÃO fica gravada — fail-safe nos
-- dois lados (PUT /api/me/avatar/modo e POST /api/me/avatar), com aviso
-- no log. Na próxima troca de foto vale o comportamento antigo: preserva
-- a figurinha se houver uma.
-- =====================================================================

ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS card_modo text CHECK (card_modo IN ('foto', 'figurinha'));

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 1 linha):
--   select column_name from information_schema.columns
--    where table_name='users' and column_name='card_modo';
-- =====================================================================
