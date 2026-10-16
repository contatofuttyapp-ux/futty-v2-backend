-- =====================================================================
-- Futty v2.0 — Migração 084: convite pendente no motor (o convite que atravessa a instalação do app).
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: quem abre o link do convite no navegador do celular, baixa o app e se cadastra nele chegava SEM time — o bilhete do
-- convite fica no armazenamento do navegador, e o app instalado pela loja tem o seu, vazio. O link copiado e o cartão "Recebeu um
-- convite?" dependem de a pessoa colar. Regra do dono: quem entrou pelo link do time TEM de entrar no time.
--
-- O QUE FAZ: quando a página do convite abre no navegador de um celular, o site avisa o motor e ele guarda UMA linha: o convite, a
-- plataforma (ios/android) e a REDE de quem abriu — o IP passado por HMAC (nunca o IP; IPv6 pelo prefixo /64). Quando alguém termina o
-- cadastro no app sem time, o app pergunta ao motor: convite da mesma rede e plataforma, aberto há no máximo 2 h, é o dela.
-- Linha com mais de 2 h não vale e o motor apaga (a cada aviso e a cada pergunta). Convite apagado leva as linhas junto (cascade).
--
-- Sem esta migração: o aviso e a pergunta falham em silêncio (um aviso no log) e tudo segue como antes — link copiado, cartão
-- "Recebeu um convite?" e o Gabinete "Contas sem time".
-- =====================================================================

create table if not exists public.convites_pendentes (
  id uuid primary key default gen_random_uuid(),
  convite_id uuid not null references public.convites(id) on delete cascade,
  rede text not null,
  plataforma text not null check (plataforma in ('ios', 'android')),
  criado_em timestamptz not null default now(),
  unique (convite_id, rede, plataforma)
);

create index if not exists convites_pendentes_rede_idx on public.convites_pendentes (rede, plataforma, criado_em desc);
create index if not exists convites_pendentes_criado_idx on public.convites_pendentes (criado_em);

comment on table public.convites_pendentes is
  'Convite aberto no navegador do celular, à espera do cadastro no app (no máximo 2 h). rede = HMAC do IP (IPv6: /64), nunca o IP. Só o motor lê e escreve (utils/convitePendente.js).';

-- Tabela nova nasce trancada (regra da 049): só o motor (service_role).
alter table public.convites_pendentes enable row level security;
revoke all on table public.convites_pendentes from public;
revoke all on table public.convites_pendentes from anon, authenticated;
grant all on table public.convites_pendentes to service_role;

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (1 linha, rls = true):
--   select relname, relrowsecurity as rls from pg_class where relname = 'convites_pendentes';
-- Reversão: drop table if exists public.convites_pendentes;
-- =====================================================================
