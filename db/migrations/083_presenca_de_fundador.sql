-- =====================================================================
-- Futty v2.0 — Migração 083: presença de fundador (data de corte no time).
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: um time que já jogava antes de entrar no app (Missa de Quinta, depois a Domingueira) tem um histórico de jogos sem a
-- presença de ninguém — o app não existia. O dono decidiu: todo membro do time, inclusive quem entrar depois, tem presença em todos
-- os jogos do time até uma data, inclusive; depois dela, a presença é a normal.
--
-- O QUE FAZ: só guarda a data. O motor (utils/presencaDeFundador.js) LÊ a regra ao somar presença — ranking, vitrine do jogador,
-- estatísticas do admin, "N jogos" do Início — e nenhuma linha nasce em game_players: a lista de presença dos jogos, o sorteio e os
-- avisos continuam falando só de quem respondeu. O dia do jogo é lido no relógio do time (teams.fuso). Sem data (null) = sem regra.
-- Desfazer = voltar a coluna do time para null.
--
-- Sem esta migração o motor novo segue funcionando: a leitura da coluna falha, a regra fica desligada e há um aviso no log.
-- =====================================================================

alter table public.teams add column if not exists presenca_fundador_ate date;

comment on column public.teams.presenca_fundador_ate is
  'Presença de fundador: todo membro que joga conta como presente em todo jogo do time com dia (no fuso do time) até esta data, inclusive. Null = sem regra. Lida pelo motor (utils/presencaDeFundador.js); não cria linhas em game_players.';
