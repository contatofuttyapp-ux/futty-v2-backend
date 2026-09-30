-- =====================================================================
-- Futty v2.0 — Migração 065: pacote do time = 2 gerações por jogador
-- (Rodada 29A, 30-set). Idempotente. ⚠️ Correr manualmente no SQL Editor
-- do Supabase (DDL é do utilizador) — junto com a 064, no dia do "publica".
--
-- POR QUÊ (dono, 26-set, "NUNCA PREJUÍZO"): todo produto tem de dar lucro
-- mesmo se a pessoa usar o máximo. Conta do pacote: sobra US$8,18 depois
-- dos 15% da loja; o custo máximo com 5 gerações por jogador era
-- 25 × 5 × US$0,112 = US$14 (prejuízo de US$5,80); com 2 gerações é
-- 50 × 0,112 = US$5,60 → margem de 31% no pior caso. O preço não muda
-- (R$49,90 / €14,99).
--
-- O QUE FAZ: o padrão de `teams.brilhante_por_jogador` passa de 5 para 2
-- e os times que ficaram com mais de 2 descem para 2. Quem já gastou mais
-- de 2 antes da mudança fica sem geração nova, nunca com saldo negativo
-- (o motor limita o "restantes" a zero).
--
-- SEM esta migração: o pacote continua a dar o que a coluna disser (5) —
-- o motor não impõe 2 por conta própria; aplicar antes de publicar.
--
-- Presente do criador (3 gerações grátis ao criar o time): ABOLIDO no
-- código. `users.presente_criador_em` fica na tabela só como histórico;
-- quem já recebeu mantém o que tem.
-- =====================================================================

ALTER TABLE IF EXISTS public.teams
  ALTER COLUMN brilhante_por_jogador SET DEFAULT 2;

UPDATE public.teams SET brilhante_por_jogador = 2 WHERE brilhante_por_jogador > 2;

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.teams ALTER COLUMN brilhante_por_jogador SET DEFAULT 5;
-- (o UPDATE não se desfaz: os times que estavam com mais de 2 já não se sabe quais eram)
-- =====================================================================
