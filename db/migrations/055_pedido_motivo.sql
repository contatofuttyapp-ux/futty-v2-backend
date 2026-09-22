-- =====================================================================
-- Futty v2.0 — Migração 055: o motivo da recusa (Figurinha 3, bloco 2)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase.
--
-- POR QUÊ: o Gabinete passa a poder RECUSAR um pedido de ativação
-- (`pedidos_ativacao.estado = 'recusado'`). Uma recusa sem motivo é uma
-- porta batida na cara: a pessoa vê o pedido sumir e não sabe porquê.
-- O motivo que o dono escreve volta para a tela dela (Figurinha/Início).
--
-- SEM esta migração aplicada: recusar continua a funcionar (o estado é
-- gravado na mesma) e o motivo NÃO é guardado — a rota avisa quem chamou
-- (`motivo_guardado: false`) e o Gabinete diz isso ao dono, em vez de
-- fingir que ficou registado.
-- =====================================================================

ALTER TABLE IF EXISTS public.pedidos_ativacao
  ADD COLUMN IF NOT EXISTS motivo text;

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 1 linha):
--   select column_name from information_schema.columns
--    where table_name='pedidos_ativacao' and column_name='motivo';
-- =====================================================================
