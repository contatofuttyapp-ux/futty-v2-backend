-- =====================================================================
-- Futty v2.0 — Migração 066: cidade normalizada do time (Rodada 29B, D,
-- 30-set). Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase
-- (DDL é do utilizador) — junto com as demais pendentes, no dia do "publica".
--
-- POR QUÊ (dono, 30-set): a cidade do time era texto livre; se a grafia
-- errasse, a geocodificação falhava em silêncio e o time ficava SEM ponto
-- (e por isso fora do Explorar). Agora o app oferece uma lista (Brasil e
-- Portugal) e, quando a cidade é outra e o Nominatim não a acha, o time
-- guarda só o texto — e o Explorar passa a casar por texto NORMALIZADO
-- (sem acento, sem maiúscula, sem espaço duplo) quando o time não tem ponto.
--
-- O QUE FAZ: acrescenta `teams.cidade_normalizada` e a preenche nos times
-- que já têm cidade. O motor a escreve a cada criação e a cada edição da
-- cidade (routes/teams.js → utils/cidade.js#normalizarCidade). A normalização
-- do backfill é a MESMA do código (NFD sem marcas, minúsculas, espaços
-- colapsados, pontas aparadas), sem depender da extensão `unaccent`.
--
-- SEM esta migração: o motor segue funcionando — cria e edita a cidade
-- (texto e ponto) como antes e o Explorar não casa por texto; só some a
-- busca por cidade sem ponto.
-- =====================================================================

ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS cidade_normalizada text;

-- Backfill: só onde falta (re-rodar não sobrescreve o que o motor já gravou).
UPDATE public.teams
SET cidade_normalizada = trim(regexp_replace(
  lower(translate(
    cidade,
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
    'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'
  )),
  '\s+', ' ', 'g'
))
WHERE cidade IS NOT NULL
  AND trim(cidade) <> ''
  AND cidade_normalizada IS NULL;

-- O Explorar só consulta isto para time SEM ponto — um índice parcial pequeno.
CREATE INDEX IF NOT EXISTS teams_cidade_normalizada_sem_ponto_idx
  ON public.teams (cidade_normalizada)
  WHERE geo_lat IS NULL;

-- =====================================================================
-- Reversão:
-- DROP INDEX IF EXISTS public.teams_cidade_normalizada_sem_ponto_idx;
-- ALTER TABLE IF EXISTS public.teams DROP COLUMN IF EXISTS cidade_normalizada;
-- =====================================================================
