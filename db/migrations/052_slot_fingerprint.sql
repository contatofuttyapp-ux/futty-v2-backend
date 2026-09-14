-- Futty v2.0 — Migração 052: impressão digital da foto em cada slot de avatar
-- IA (build 9). Achado real (logs do Cloud Run): POST /api/me/avatar/ai
-- devolvia "slot reutilizado" mesmo depois de uma foto NOVA — o slot foi
-- gerado da foto ANTIGA e o motor não tinha como saber que a foto mudou.
-- Guarda-se aqui a mesma foto_hash (migração 048) que estava vigente quando
-- o slot foi gerado; routes/auth.js só reutiliza se ela bater com a foto_hash
-- ATUAL do usuário — senão gera de novo (com quota normal).
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).
--
-- Nota (achado do scripts/conferir-migracoes.js): user_avatar_slots não tem
-- CREATE TABLE em nenhuma migração rastreada — foi criada por fora, direto
-- no Supabase. Por isso o ADD COLUMN aqui é IF EXISTS/IF NOT EXISTS, e por
-- isso mesmo a tabela pode não aparecer na lista do script se ele só souber
-- ler `CREATE TABLE` — ver comentário no próprio script.

ALTER TABLE IF EXISTS public.user_avatar_slots ADD COLUMN IF NOT EXISTS foto_fingerprint text;
