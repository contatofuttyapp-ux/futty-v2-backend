-- =====================================================================
-- Futty v2.0 — Migração 057: foto original (reenquadrar) + histórico de
-- figurinhas (Rodada 19, 23-set). Idempotente. ⚠️ Correr manualmente no
-- SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: "Ajustar enquadramento" (dentro de "Trocar foto") reabre o
-- recorte sobre a foto ORIGINAL enviada, não sobre o recorte 2:3 já salvo —
-- senão cada reenquadramento perde qualidade e área (recorte de recorte).
-- Guardar as últimas 6 figurinhas evita que regenerar apague a anterior
-- sem dar como voltar atrás.
--
-- SEM esta migração aplicada: routes/auth.js funciona exatamente como
-- antes — POST /api/me/avatar grava foto_url normalmente e não tenta
-- gravar foto_original_url (fail-safe, mesmo padrão de foto_hash na 048);
-- "Ajustar enquadramento" cai no fallback (reabre sobre o recorte atual,
-- só aproxima, nunca erro); a figurinha nova continua a apagar a anterior
-- (comportamento de sempre) em vez de arquivá-la.
-- =====================================================================

-- (a) A foto ORIGINAL (antes do recorte 2:3) — nome por versão, igual a
-- foto_url. Nula para quem nunca passou por "Escolher outra foto" depois
-- desta rodada (onboarding e uploads antigos não mandam original).
ALTER TABLE IF EXISTS public.users ADD COLUMN IF NOT EXISTS foto_original_url text;

-- (b) Histórico de figurinhas — teto de 6 por pessoa, aplicado em
-- aplicação (não em SQL): ao gravar a 7ª, o motor apaga a mais antiga
-- (linha + arquivo no Storage). `kit_id` e `custo_cents` no mesmo formato
-- de brilhantes_time (migração 054).
CREATE TABLE IF NOT EXISTS public.user_avatar_historico (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kit_id      text NOT NULL,
  avatar_url  text NOT NULL,
  custo_cents integer,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

-- "As últimas 6 de uma pessoa" é a única pergunta que este índice serve.
CREATE INDEX IF NOT EXISTS user_avatar_historico_user_idx
  ON public.user_avatar_historico(user_id, criado_em DESC);

-- RLS/grants no padrão da migração 049 (trancar_banco): tabela nova nasce
-- SEM grant nenhum para anon/authenticated (default privileges já revogados
-- por ela) — ligar RLS aqui é defesa em profundidade, sem policy nenhuma
-- (acesso zero para esses roles). O backend usa service_role, que ignora
-- RLS e não muda nada para ele.
ALTER TABLE IF EXISTS public.user_avatar_historico ENABLE ROW LEVEL SECURITY;

-- =====================================================================
-- Reversão (não recomendada — perde o histórico já guardado):
-- DROP TABLE IF EXISTS public.user_avatar_historico;
-- ALTER TABLE IF EXISTS public.users DROP COLUMN IF EXISTS foto_original_url;
-- =====================================================================
