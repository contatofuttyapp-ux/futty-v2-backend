-- =====================================================================
-- Futty v2.0 — Migração 067: "Só organizo" — team_members.joga
-- (Rodada 29B, E, 30-set). Idempotente. ⚠️ Correr manualmente no SQL
-- Editor do Supabase (DDL é do utilizador) — junto com as demais pendentes,
-- no dia do "publica".
--
-- POR QUÊ (dono, 30-set): quem cria o time nem sempre joga — organiza. Hoje
-- o criador entra na lista de presença, no sorteio e no ranking como se
-- fosse jogador. Ao criar o time e nas configurações ele escolhe "Eu jogo"
-- ou "Só organizo o time".
--
-- O QUE FAZ: acrescenta `team_members.joga` (boolean, padrão true — todo
-- mundo que já existe continua jogando). Quem tem joga = false:
--   · administra tudo (jogos, sorteio, resultados, Resenha);
--   · NÃO entra na lista de presença (RSVP/confirmar) nem no sorteio;
--   · NÃO aparece no ranking;
--   · NÃO conta no pacote do time (as 25 vagas e as gerações).
-- O motor respeita isto em routes/rsvp.js, routes/games.js, routes/ranking.js
-- e utils/direitoBrilhante.js (leitura em utils/soOrganiza.js).
--
-- SEM esta migração: o motor segue funcionando — a leitura de `joga` falha
-- com aviso no log e todos são tratados como jogadores; criar o time com
-- "Só organizo" cria o time com o criador jogando, e trocar o papel nas
-- configurações responde "essa opção ainda não está disponível".
-- =====================================================================

ALTER TABLE IF EXISTS public.team_members
  ADD COLUMN IF NOT EXISTS joga boolean NOT NULL DEFAULT true;

-- O motor só pergunta por quem NÃO joga (poucas linhas): índice parcial pequeno.
CREATE INDEX IF NOT EXISTS team_members_so_organiza_idx
  ON public.team_members (team_id)
  WHERE joga = false;

-- =====================================================================
-- Reversão:
-- DROP INDEX IF EXISTS public.team_members_so_organiza_idx;
-- ALTER TABLE IF EXISTS public.team_members DROP COLUMN IF EXISTS joga;
-- =====================================================================
