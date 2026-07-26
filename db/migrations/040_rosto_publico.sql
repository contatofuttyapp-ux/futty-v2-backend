-- =====================================================================
-- Futty v2.0 — Migração 040: rosto público nas partilhas /p/ (Opção B).
-- Regra dura no servidor (GET /api/p/:gameId, utils/rostoPublico.js): o rosto
-- só se revela numa partilha pública SE o dono for ADULTO (is_adult(birthdate),
-- >=18) E tiver o consentimento ligado (mostrar_rosto_publico). Menor · sem
-- birthdate · sem consentimento · convidado → SILHUETA, sempre (fail-closed).
-- A idade manda MESMO com a flag ligada.
--
-- DEFAULT = TRUE (decisão do utilizador: "maiores de idade, entra o rosto de
-- toda a gente"). A proteção real é a IDADE; o toggle (Perfil → Privacidade) é
-- para DESLIGAR. O middleware mediaUrls fica intocado: para quem PODE, o handler
-- reescreve o avatar para um URL do proxy público (/api/media/<token>), que não
-- bate no regex de despublicarPayload; para quem não pode, fica '' (silhueta).
--
-- 040b: termo de quem partilha (aceite 1-clique no "Copiar/Compartilhar") —
-- registo de auditoria; NÃO altera a privacidade (a regra de rosto é sempre
-- ligada), é só cobertura legal.
--
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

-- 040 — consentimento de rosto público (opt-out; default TRUE)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS mostrar_rosto_publico BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.users.mostrar_rosto_publico IS
  'Opt-out: default TRUE. Regra dura no servidor: so revela rosto no /p/ se is_adult(birthdate) AND mostrar_rosto_publico; menor/sem-dob/sem-consentimento -> silhueta (a idade manda).';

-- 040b — termo de quem partilha (registo do aceite 1-clique)
CREATE TABLE IF NOT EXISTS public.share_declarations (
  game_id     uuid        NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, user_id)
);
