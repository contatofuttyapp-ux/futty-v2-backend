-- =====================================================================
-- Futty v2.0 — Migração 053: bytes de cada mídia da Resenha + cota por time
-- (Rodada 15, 16-set). Idempotente. ⚠️ Correr manualmente no SQL Editor do
-- Supabase (DDL é do utilizador).
--
-- POR QUÊ: uma foto de celular sem compressão tem 3-5 MB; 100 GB do plano
-- dariam só ~25 mil fotos. A Rodada 15 comprime no upload (routes/feed.js) e
-- limita cada time a 500 MB de mídia na Resenha. Para bloquear a cota é
-- preciso somar quanto cada time já usa — e sem o tamanho gravado por
-- arquivo não há o que somar.
--
-- SEM esta migração aplicada: routes/feed.js funciona exatamente como antes
-- — bytesUsadosPeloTime()/bytesUsadosPorTodosOsTimes() (utils/resenhaCota.js)
-- devolvem null/{} ao ver a coluna ou a função em falta, e a cota
-- simplesmente NÃO bloqueia (fail-open, com aviso no log a cada tentativa).
-- =====================================================================

ALTER TABLE IF EXISTS public.feed_post_media ADD COLUMN IF NOT EXISTS bytes integer;

-- Soma os bytes de mídia de UM time (join com feed_posts, que é quem tem
-- team_id). Usada na hora de aceitar/recusar um post novo.
CREATE OR REPLACE FUNCTION public.feed_bytes_por_time(p_team_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(m.bytes), 0)::bigint
  FROM public.feed_post_media m
  JOIN public.feed_posts p ON p.id = m.post_id
  WHERE p.team_id = p_team_id;
$$;

-- A mesma soma, mas para TODOS os times de uma vez (Gabinete → Pessoas &
-- times, "MB de N" por time) — uma função à parte em vez de N chamadas da
-- de cima, que seria N idas ao banco para uma tela que lista todo mundo.
CREATE OR REPLACE FUNCTION public.feed_bytes_por_todos_times()
RETURNS TABLE(team_id uuid, bytes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.team_id, coalesce(sum(m.bytes), 0)::bigint AS bytes
  FROM public.feed_posts p
  JOIN public.feed_post_media m ON m.post_id = p.id
  GROUP BY p.team_id;
$$;

-- Dona explícita e EXECUTE só para service_role — mesma receita da migração
-- 050 (gabinete_rls_status): anon/authenticated nunca chamam isto direto,
-- só o backend (que já filtra quem pode perguntar sobre qual time).
ALTER FUNCTION public.feed_bytes_por_time(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.feed_bytes_por_time(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feed_bytes_por_time(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_bytes_por_time(uuid) TO service_role;

ALTER FUNCTION public.feed_bytes_por_todos_times() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.feed_bytes_por_todos_times() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feed_bytes_por_todos_times() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_bytes_por_todos_times() TO service_role;
