-- =====================================================================
-- Futty v2.0 — Migração 031: controlo de capacidade por jogo.
-- max_jogadores NULL = sem limite. Quando definido, o RSVP bloqueia novas
-- confirmações ao atingir o limite (lista de espera fica para o item 27).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS max_jogadores INT;
