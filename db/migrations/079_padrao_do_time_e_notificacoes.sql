-- =====================================================================
-- Futty v2.0 — Migração 079: jogadores por time (padrão do time) e as
-- notificações que cada pessoa quer receber (Rodada 29I, bloco 3).
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase
-- (DDL é do utilizador) — junto com a 076, a 077 e a 078.
--
-- 1) JOGADORES POR TIME (item 68 da Rodada 29): era perguntado duas vezes —
--    na criação do time e em cada jogo novo. Agora é UM padrão do time
--    (Ajustes do time) e o "Novo jogo" já vem com ele, dobrado: "Padrão do
--    time: 5 · mudar só neste jogo". O jogo continua guardando o seu
--    (games.jogadores_por_time); isto é só o padrão.
--      · teams.jogadores_por_time  smallint, 2–11 (null = 5)
--
-- 2) NOTIFICAÇÕES CONFIGURÁVEIS (dono, 2-out): Perfil → Notificações, com um
--    interruptor por tipo — jogos e presença; pedidos de entrada (só admin);
--    figurinha pronta; Resenha. Todas ligadas por padrão: a coluna guarda só
--    o que a pessoa DESLIGOU ({"pedidos": false}); chave ausente = ligada.
--      · users.notificacoes  jsonb not null default '{}'
--
-- SEM esta migração: o motor segue funcionando — o "Novo jogo" usa 5 e a
-- tela de notificações avisa que a escolha ainda não pode ser salva (todas
-- continuam ligadas, como sempre foram).
-- =====================================================================

ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS jogadores_por_time smallint;

ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_jogadores_por_time_check;
ALTER TABLE IF EXISTS public.teams ADD CONSTRAINT teams_jogadores_por_time_check
  CHECK (jogadores_por_time IS NULL OR jogadores_por_time BETWEEN 2 AND 11);

ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS notificacoes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.users DROP COLUMN IF EXISTS notificacoes;
-- ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_jogadores_por_time_check;
-- ALTER TABLE IF EXISTS public.teams DROP COLUMN IF EXISTS jogadores_por_time;
-- =====================================================================
