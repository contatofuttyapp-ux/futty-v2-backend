-- =====================================================================
-- Futty v2.0 — Migração 073: bairro do time e prêmios do time (Rodada 29H,
-- itens 6 e 12, 2-out). Idempotente. ⚠️ Correr manualmente no SQL Editor do
-- Supabase (DDL é do utilizador) — junto com as demais pendentes, no dia do
-- "publica".
--
-- 1) BAIRRO (dono, 2-out): a coordenada do time era o centro da CIDADE — todos
--    os times de "São Paulo" no mesmo ponto, e o Explorar ordenava pela
--    distância até esse ponto. Agora o admin pode declarar, opcionalmente, o
--    bairro ("Pinheiros" em "São Paulo, SP"; em Portugal, a freguesia). O motor
--    geocodifica "bairro, cidade" UMA vez (Nominatim, como a cidade) e, quando
--    acha, o ponto do time passa a ser o do bairro (arredondado, ~1 km). Se não
--    acha, o time fica com o ponto da cidade e o app avisa. Nunca o endereço.
--      · teams.bairro             o texto que o admin declarou (até 80)
--      · teams.bairro_normalizado o mesmo, sem acento/maiúscula/espaço sobrando
--
-- 2) PRÊMIOS DO TIME (item 44): "Artilheiro do dia" e "Destaque do dia" no Criar
--    time eram chaves apagadas ("em breve") — o dono não conseguia clicar. Viram
--    escolhas de verdade, por time: ligadas (padrão), o editor de resultado
--    oferece o troféu de artilheiro / o destaque do dia; desligadas, o editor
--    esconde a seção (o que já foi premiado continua no histórico).
--      · teams.mostrar_artilheiro boolean not null default true
--      · teams.mostrar_destaque   boolean not null default true
--
-- O motor lê/escreve estas colunas com tolerância: sem a migração a criação e a
-- edição do time seguem como antes (só o bairro e os dois prêmios ficam de fora)
-- e o app avisa "ainda não está disponível" quando a pessoa tenta usá-los.
-- =====================================================================

ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS bairro text,
  ADD COLUMN IF NOT EXISTS bairro_normalizado text,
  ADD COLUMN IF NOT EXISTS mostrar_artilheiro boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_destaque boolean NOT NULL DEFAULT true;

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.teams
--   DROP COLUMN IF EXISTS bairro,
--   DROP COLUMN IF EXISTS bairro_normalizado,
--   DROP COLUMN IF EXISTS mostrar_artilheiro,
--   DROP COLUMN IF EXISTS mostrar_destaque;
-- =====================================================================
