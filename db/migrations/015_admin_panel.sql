-- =====================================================================
-- Futty v2.0 — Migração 015: painel de admin (editar/cancelar jogos)
-- Idempotente.
-- =====================================================================

-- Marca temporal do cancelamento do jogo.
alter table public.games
  add column if not exists cancelado_at timestamptz;

-- Nota: as stats por jogador (gols/artilharia/vitorias/destaque) e a coluna
-- pode_postar já existem em team_members (migrações 005 e 010) — não duplicar.
-- Nota: o status de cancelamento usa o valor 'cancelado' (PT), já permitido
-- pelo CHECK de games.status (migração 001/003).
