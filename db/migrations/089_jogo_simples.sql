-- =====================================================================
-- Futty v2.0 — Migração 089: o jogo simples — criar já chama todo mundo, sorteio com hora marcada e o registro dos avisos.
-- Idempotente e aditiva. ⚠️ Rodar à mão no SQL Editor do Supabase (o DDL é do dono).
--
-- POR QUÊ: criar um jogo não chamava ninguém; o admin tinha de "abrir a presença" com um prazo e "fechar" depois. Agora o jogo nasce
-- chamando o elenco (ou quem o admin escolher), o "Vou / Não vou" aparece na hora e a lista fecha sozinha na hora do sorteio.
--
-- O QUE FAZ:
--   · games.sorteio_em  — a hora do sorteio, que é também quando a lista de presença fecha. NULL = 1 hora antes do jogo (o motor
--                         calcula), então os jogos que já existem não precisam de nada.
--   · games.chamados    — quem foi chamado para o jogo (ids de usuário). NULL = TODO o elenco, inclusive quem entrar no time depois.
--   · jogo_avisos       — cada evento que avisa gente (jogo criado, chamou mais alguém, mudou data/hora/local), com os destinatários e
--                         quando o Web Push saiu. É o cano por onde o push nativo (iOS/Android) vai passar na rodada seguinte.
--                         Trancada (só o motor), como as outras.
-- O QUE NÃO FAZ: não apaga games.rsvp_aberto / rsvp_fechado / rsvp_prazo (deixam de ser usadas, ficam onde estão), não mexe em
-- jogo nenhum no bloco principal, não muda resposta de ninguém. O ACERTO no fim (jogos com a presença antiga aberta) é à parte.
--
-- A ORDEM NÃO QUEBRA NADA: o motor novo funciona antes desta migração (sem as colunas, todo jogo chama o elenco e sorteia 1 h antes;
-- o registro dos avisos só vai para o log) e o motor antigo ignora as colunas. Rodar de novo não estraga nada.
-- =====================================================================

alter table public.games add column if not exists sorteio_em timestamptz;
alter table public.games add column if not exists chamados uuid[];

comment on column public.games.sorteio_em is 'Hora do sorteio = quando a lista de presença fecha. NULL = 1 hora antes do jogo. Só o motor escreve.';
comment on column public.games.chamados is 'Quem foi chamado para o jogo. NULL = todo o elenco (também quem entrar depois). Só o motor escreve.';

create table if not exists public.jogo_avisos (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid references public.games (id) on delete cascade,
  team_id         uuid references public.teams (id) on delete cascade,
  tipo            text not null check (tipo in ('criado', 'chamado', 'mudou')),
  destinatarios   uuid[] not null default '{}',
  detalhe         jsonb,
  criado_em       timestamptz not null default now(),
  web_enviado_em  timestamptz
);
create index if not exists jogo_avisos_jogo on public.jogo_avisos (game_id, criado_em);

-- Trancada (o padrão da casa, db/migrations/LEIA-ME.md): RLS ligada, nada para anon/authenticated, tudo para o motor.
alter table public.jogo_avisos enable row level security;
revoke all on table public.jogo_avisos from public;
revoke all on table public.jogo_avisos from anon, authenticated;
grant all on table public.jogo_avisos to service_role;

comment on table public.jogo_avisos is 'Avisos de jogo (criado, chamado, mudou): quem e quando. Só o motor lê e escreve.';

notify pgrst, 'reload schema';

-- =====================================================================
-- CONFERIR DEPOIS DE RODAR
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'games' and column_name in ('sorteio_em', 'chamados');
-- → sorteio_em | timestamp with time zone · chamados | ARRAY
-- select r, has_table_privilege(r, 'public.jogo_avisos', 'select') as ler, has_table_privilege(r, 'public.jogo_avisos', 'insert') as gravar
--   from unnest(array['service_role', 'authenticated', 'anon']) r;
-- → service_role: true / true · authenticated e anon: false / false
--
-- DESFAZER:
-- drop table if exists public.jogo_avisos;
-- alter table public.games drop column if exists chamados, drop column if exists sorteio_em;
-- =====================================================================

-- =====================================================================
-- ACERTO DOS JOGOS COM PRESENÇA ABERTA DO JEITO ANTIGO (rode DEPOIS do bloco acima; idempotente)
-- Antes, com a presença "aberta", o "Vou" ficava só em rsvp_respostas e ia para game_players (de onde o sorteio lê) no "Fechar presença".
-- O "Fechar" não existe mais: sem este acerto, quem disse "Vou" num jogo aberto do jeito antigo ficaria fora do sorteio. Mexe SÓ em jogos
-- futuros, não sorteados, não cancelados, com a presença antiga aberta e não fechada. Quem respondeu continua com a mesma resposta.
--
-- 1) CONFERIR (só leitura): quantas respostas desses jogos ainda não estão no elenco do jogo.
-- select g.id as jogo, g.data, count(*) filter (where r.status = 'confirmado' and coalesce(gp.confirmado, false) = false) as vou_fora_do_elenco,
--        count(*) filter (where r.status = 'recusado' and gp.confirmado = true) as nao_vou_ainda_no_elenco
--   from public.games g
--   join public.rsvp_respostas r on r.game_id = g.id
--   left join public.game_players gp on gp.game_id = g.id and gp.user_id = r.user_id
--  where g.rsvp_aberto = true and coalesce(g.rsvp_fechado, false) = false and coalesce(g.sorteio_realizado, false) = false
--    and coalesce(g.cancelado, false) = false and g.status <> 'cancelado' and g.data > now()
--  group by g.id, g.data order by g.data;
-- → nenhuma linha (ou tudo 0): não precisa rodar o passo 2.
--
-- 2) ACERTAR: leva as respostas para o elenco do jogo (o goleiro vem do que já estava no jogo ou, se não estava, da posição no time).
insert into public.game_players (game_id, user_id, confirmado, goleiro)
select r.game_id, r.user_id, (r.status = 'confirmado'),
       coalesce(gp.goleiro, exists (select 1 from public.team_members tm where tm.team_id = g.team_id and tm.user_id = r.user_id and tm.categoria = 'GR'))
  from public.games g
  join public.rsvp_respostas r on r.game_id = g.id
  left join public.game_players gp on gp.game_id = g.id and gp.user_id = r.user_id
 where g.rsvp_aberto = true and coalesce(g.rsvp_fechado, false) = false and coalesce(g.sorteio_realizado, false) = false
   and coalesce(g.cancelado, false) = false and g.status <> 'cancelado' and g.data > now()
   and r.status in ('confirmado', 'recusado')
on conflict (game_id, user_id) do update set confirmado = excluded.confirmado;
--
-- 3) O OUTRO LADO (idempotente): o "Vou" simples de antes (jogo sem presença aberta) só foi para game_players. A lotação do jogo conta
--    pela lista (rsvp_respostas); este passo copia esses "Vou" para lá, sem tocar em quem já tem resposta. Só jogos futuros, não sorteados.
insert into public.rsvp_respostas (game_id, user_id, status)
select gp.game_id, gp.user_id, 'confirmado'
  from public.game_players gp
  join public.games g on g.id = gp.game_id
 where gp.confirmado = true and coalesce(g.sorteio_realizado, false) = false
   and coalesce(g.cancelado, false) = false and g.status <> 'cancelado' and g.data > now()
on conflict (game_id, user_id) do nothing;
-- Rodar a conferência de novo → tudo 0.
-- (Não tem "desfazer": a resposta de cada um já era essa; o passo só a leva para onde o sorteio lê.)
-- =====================================================================
