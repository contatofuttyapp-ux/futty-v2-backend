-- Futty v2.0 — Migração 051: status da figurinha automática do cadastro (12-set).
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).
--
-- POR QUÊ: o Onboarding agora dispara POST /api/me/avatar/ai em fire-and-forget
-- assim que a foto sobe (sem o usuário esperar na tela de upload) e segue para
-- nome/posição. O Início precisa saber se a figurinha ainda está sendo gerada,
-- pronta ou falhou, para trocar o card por um estado de "criando..." — sem essas
-- colunas não há onde guardar isso entre um pedido e outro.
--
-- figurinha_status:    null | 'gerando' | 'pronta' | 'falhou'
-- figurinha_status_em: timestamp da última mudança de status (o backend trata
--                      'gerando' com mais de 3 min como 'falhou' na leitura,
--                      caso o processo tenha caído no meio da geração).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS figurinha_status text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS figurinha_status_em timestamptz;
