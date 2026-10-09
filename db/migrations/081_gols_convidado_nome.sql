-- =====================================================================
-- Futty v2.0 — Migração 081: gol de convidado sem app, pelo nome
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================
-- Até aqui user_id era obrigatório e o convidado sem app (sem conta) não tinha onde
-- cair: o gol dele era descartado ao salvar. Agora ele grava por nome — a mesma chave
-- (utils/registroDoSorteio.js#chaveDoJogador) que o motor já usa para localizar
-- convidados nos times e recusar um repetido.

ALTER TABLE public.gols_jogadores
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS convidado_nome text;

ALTER TABLE public.gols_jogadores
  DROP CONSTRAINT IF EXISTS gols_jogadores_identidade_check;
ALTER TABLE public.gols_jogadores
  ADD CONSTRAINT gols_jogadores_identidade_check
    CHECK (user_id IS NOT NULL OR convidado_nome IS NOT NULL);
