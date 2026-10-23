-- =====================================================================
-- Futty v2.0 — Migração 087: os convidados sem app ficam guardados no JOGO, não só no sorteio.
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: o admin escreve em "Alguém sem o app vai jogar?" os nomes de quem joga sem conta. Até aqui essa lista vivia só na tela e
-- ia dentro do pedido do sorteio; recarregar a página antes de sortear perdia tudo, e depois do sorteio ela só existia dentro de
-- `times_resultado`. Agora cada convidado é guardado no jogo com o nome e as duas marcas do sorteio (goleiro, cabeça de chave), e o
-- "Sortear de novo" usa a mesma lista sem ninguém digitar de novo.
--
-- O QUE FAZ: cria `games.convidados` (jsonb, lista de { nome, goleiro, cabeca_chave }). NULL = o jogo nunca gravou a lista: o motor
-- lê os convidados do sorteio salvo (`times_resultado`), e é assim que os jogos de antes desta migração continuam certos sem mexer neles.
-- O QUE NÃO FAZ: não cria tabela (a coluna é do `games`, que já tem as permissões dele), não mexe em jogo nenhum, não cria linha em
-- `users` (convidado sem app nunca vira conta).
--
-- A ORDEM NÃO QUEBRA NADA: o motor novo funciona antes desta migração (lê do sorteio e o sorteio grava sem a coluna) e o motor antigo
-- ignora a coluna. Rodar de novo não estraga nada.
-- =====================================================================

alter table public.games add column if not exists convidados jsonb;

comment on column public.games.convidados is
  'Convidados sem app do jogo: [{ nome, goleiro, cabeca_chave }]. NULL = nunca gravada (o motor lê do times_resultado). Só o motor escreve.';

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (tem de devolver 1 linha: convidados | jsonb | YES)
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'games' and column_name = 'convidados';
-- =====================================================================
