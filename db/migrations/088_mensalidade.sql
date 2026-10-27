-- =====================================================================
-- Futty v2.0 — Migração 088: a mensalidade do time ("pagou / não pagou") e o "Traga seu histórico".
-- Idempotente e aditiva. ⚠️ Rodar à mão no SQL Editor do Supabase (o DDL é do dono).
--
-- POR QUÊ: o admin quer saber quem pagou a mensalidade sem caderno nem planilha. O app NÃO mexe em dinheiro: é uma lista
-- "pagou / não pagou" com o jeito de pagar que o admin escreve (um link ou um texto), um "Já paguei" do jogador e um lembrete
-- no dia do vencimento. E, para saber se vale fazer a importação de histórico, guarda-se quem tocou no "Traga seu histórico".
--
-- O QUE FAZ (quatro tabelas novas, todas TRANCADAS: só o motor lê e escreve — o celular passa sempre pelo motor):
--   · team_mensalidade        — a configuração, UMA linha por time (tabela 1:1 e não colunas em `teams`: o `teams` é lido em
--                               quase toda rota, e a mensalidade desligada não pode mudar nada nelas). Sem linha = desligada.
--   · mensalidade_pagamentos  — um registro por (time, jogador, mês) só quando há algo a dizer: 'pago' ou 'avisou' (o jogador
--                               tocou "Já paguei" e o admin ainda não confirmou). SEM registro = em aberto: o mês novo começa
--                               com todo mundo em aberto sem job nenhum, e os meses passados ficam guardados.
--   · mensalidade_lembretes   — o lembrete do vencimento já enviado a (time, jogador, mês): no máximo 1 por pessoa por mês,
--                               mesmo com várias instâncias do motor rodando ao mesmo tempo.
--   · historico_interesse     — cada toque em "Enviar por e-mail" do "Traga seu histórico" (de onde: criar time, ranking, resenha).
--
-- EXCLUIR CONTA / SAIR DO TIME: excluir a conta apaga os registros dela (on delete cascade); apagar o time também. Sair do
-- time NÃO apaga: a lista mostra só quem é membro hoje, então o registro de quem saiu some da tela e volta se a pessoa voltar
-- (o mês que ela já tinha pago continua pago). `marcado_por` de um admin que exclui a conta vira NULL (o registro fica).
--
-- A ORDEM NÃO QUEBRA NADA: o motor novo funciona sem esta migração (a mensalidade aparece como indisponível e o resto do time
-- segue igual) e o motor antigo não conhece as tabelas. Rodar de novo não estraga nada.
-- =====================================================================

create table if not exists public.team_mensalidade (
  team_id         uuid primary key references public.teams (id) on delete cascade,
  ativa           boolean not null default false,
  valor           text check (valor is null or char_length(valor) <= 40),
  dia_vencimento  smallint check (dia_vencimento is null or dia_vencimento between 1 and 31),
  como_pagar      text check (como_pagar is null or char_length(como_pagar) <= 300),
  lista_publica   boolean not null default false,
  lembrete        boolean not null default true,
  atualizada_em   timestamptz not null default now(),
  atualizada_por  uuid references public.users (id) on delete set null
);

create table if not exists public.mensalidade_pagamentos (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  mes         date not null check (extract(day from mes) = 1),
  status      text not null check (status in ('pago', 'avisou')),
  marcado_por uuid references public.users (id) on delete set null,
  marcado_em  timestamptz not null default now(),
  unique (team_id, user_id, mes)
);
create index if not exists mensalidade_pagamentos_time_mes on public.mensalidade_pagamentos (team_id, mes);

create table if not exists public.mensalidade_lembretes (
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  mes         date not null check (extract(day from mes) = 1),
  enviado_em  timestamptz not null default now(),
  primary key (team_id, user_id, mes)
);

create table if not exists public.historico_interesse (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid references public.teams (id) on delete cascade,
  user_id    uuid references public.users (id) on delete set null,
  origem     text not null check (origem in ('criar_time', 'ranking', 'resenha')),
  criado_em  timestamptz not null default now()
);

-- Trancadas (o padrão da casa, db/migrations/LEIA-ME.md): RLS ligada, nada para anon/authenticated, tudo para o motor.
alter table public.team_mensalidade enable row level security;
alter table public.mensalidade_pagamentos enable row level security;
alter table public.mensalidade_lembretes enable row level security;
alter table public.historico_interesse enable row level security;

revoke all on table public.team_mensalidade from public;
revoke all on table public.mensalidade_pagamentos from public;
revoke all on table public.mensalidade_lembretes from public;
revoke all on table public.historico_interesse from public;
revoke all on table public.team_mensalidade from anon, authenticated;
revoke all on table public.mensalidade_pagamentos from anon, authenticated;
revoke all on table public.mensalidade_lembretes from anon, authenticated;
revoke all on table public.historico_interesse from anon, authenticated;
grant all on table public.team_mensalidade to service_role;
grant all on table public.mensalidade_pagamentos to service_role;
grant all on table public.mensalidade_lembretes to service_role;
grant all on table public.historico_interesse to service_role;

comment on table public.team_mensalidade is 'Mensalidade do time (1:1). Sem linha = desligada. Só o motor lê e escreve.';
comment on table public.mensalidade_pagamentos is 'Mensalidade: pago | avisou por (time, jogador, mês). Sem linha = em aberto. Só o motor.';
comment on table public.mensalidade_lembretes is 'Lembrete do vencimento já enviado (no máximo 1 por pessoa por mês). Só o motor.';
comment on table public.historico_interesse is 'Toques em "Traga seu histórico" (para medir a demanda da importação). Só o motor.';

notify pgrst, 'reload schema';

-- =====================================================================
-- CONFERIR DEPOIS DE RODAR (as 12 linhas: o motor pode tudo, o celular nada)
-- select t, r, has_table_privilege(r, 'public.' || t, 'select') as ler, has_table_privilege(r, 'public.' || t, 'insert') as gravar
--   from unnest(array['team_mensalidade', 'mensalidade_pagamentos', 'mensalidade_lembretes', 'historico_interesse']) t,
--        unnest(array['service_role', 'authenticated', 'anon']) r
--  order by t, r;
-- → service_role: true / true · authenticated e anon: false / false
--
-- DESFAZER (apaga a mensalidade de todos os times e os toques do histórico):
-- drop table if exists public.mensalidade_lembretes, public.mensalidade_pagamentos, public.team_mensalidade, public.historico_interesse;
-- =====================================================================
