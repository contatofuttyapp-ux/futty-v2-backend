-- =====================================================================
-- Futty v2.0 — Migração 016: novo modelo de votação
-- 1 voto por (votante, votado, equipa); permanente/atualizável; meias estrelas.
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

-- game_id passa a opcional (histórico preservado).
alter table public.votes alter column game_id drop not null;

-- updated_at (voto atualizável).
alter table public.votes add column if not exists updated_at timestamptz not null default now();

-- nota passa a aceitar meias estrelas (1, 1.5, ... 5) → numeric(2,1).
alter table public.votes alter column nota type numeric(2, 1) using nota::numeric(2, 1);
alter table public.votes drop constraint if exists votes_nota_check;
alter table public.votes add constraint votes_nota_check
  check (nota >= 1 and nota <= 5 and mod((nota * 10)::int, 5) = 0);

-- Remove as constraints de unicidade antigas.
alter table public.votes drop constraint if exists votes_unique_por_jogo;
alter table public.votes drop constraint if exists votes_de_user_id_para_user_id_game_id_key;

-- Dedup antes da nova unique: mantém o voto mais recente por (de, para, equipa).
delete from public.votes v
where v.id not in (
  select distinct on (de_user_id, para_user_id, team_id) id
  from public.votes
  order by de_user_id, para_user_id, team_id, created_at desc
);

-- Nova unicidade: 1 voto por votante por votado por equipa.
alter table public.votes add constraint votes_unique_por_equipa
  unique (de_user_id, para_user_id, team_id);

-- Pedido de revotação (timestamp do último pedido do admin).
alter table public.teams add column if not exists revotar_pedido_em timestamptz;

-- Categoria do membro (linha | GR). Auto-popular GR = quem já foi goleiro.
alter table public.team_members add column if not exists categoria text not null default 'linha';
alter table public.team_members drop constraint if exists team_members_categoria_check;
alter table public.team_members add constraint team_members_categoria_check
  check (categoria in ('linha', 'GR'));

update public.team_members tm
set categoria = 'GR'
where exists (
  select 1
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  where gp.user_id = tm.user_id and g.team_id = tm.team_id and gp.goleiro = true
);
