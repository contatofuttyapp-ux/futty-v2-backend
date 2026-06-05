-- =====================================================================
-- Futty v2.0 — Migração 011: campos de resultado/Resenha em games
-- artilheiro, destaque, rodada de cerveja, foto de campeão e índice do
-- time vencedor. Todos opcionais. Idempotente.
-- FKs de jogador para public.users com ON DELETE SET NULL (apagar um
-- utilizador limpa o prémio mas mantém o jogo).
-- =====================================================================

alter table public.games
  add column if not exists artilheiro_user_id uuid references public.users (id) on delete set null,
  add column if not exists artilheiro_gols    int  check (artilheiro_gols >= 0),
  add column if not exists destaque_user_id   uuid references public.users (id) on delete set null,
  add column if not exists destaque_titulo    text check (char_length(destaque_titulo) <= 60),
  add column if not exists rodada_user_id     uuid references public.users (id) on delete set null,
  add column if not exists rodada_foto_url    text,
  add column if not exists campeao_foto_url   text,
  add column if not exists campeao_time_index int;
-- campeao_time_index: índice (0-based) do time vencedor em times_resultado
