-- =====================================================================
-- Futty v2.0 — Migração 062: cadastro só a partir de 13 anos (Rodada 28, bloco C; LGPD art. 14)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: o cadastro por e-mail vai direto do app para o Supabase Auth (supabase.auth.signUp),
-- sem passar pelo motor, com a data de nascimento no user_metadata. O app já recusa menor de 13
-- antes de chamar o signUp, e o motor recusa no onboarding (PATCH /api/me e
-- /api/me/onboarding-completo). Esta trava fecha a porta que sobra: quem chamar o signUp à mão com
-- uma data de menor de 13 não ganha conta — o banco recusa a linha em auth.users.
--
-- O QUE NÃO FAZ: não mexe em conta existente; não exige a data (Google/Apple e as contas criadas
-- pelos scripts de teste não a trazem — nesses casos quem confere é o onboarding); data ilegível
-- não bloqueia (o motor confere de novo).
--
-- SEM esta migração: continua valendo a trava do app e a do motor.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bloquear_cadastro_menor_13()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  nascimento date;
BEGIN
  IF NEW.raw_user_meta_data IS NULL OR NOT (NEW.raw_user_meta_data ? 'birthdate') THEN
    RETURN NEW;
  END IF;
  BEGIN
    nascimento := (NEW.raw_user_meta_data ->> 'birthdate')::date;
  EXCEPTION WHEN others THEN
    RETURN NEW; -- data ilegível: quem confere é o onboarding
  END;
  -- Faz 13 anos hoje = pode. Ainda não fez = não pode.
  IF nascimento > (current_date - INTERVAL '13 years') THEN
    RAISE EXCEPTION 'MENOR_DE_13: o Futty é para maiores de 13 anos'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_13() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_13() FROM anon, authenticated;

DROP TRIGGER IF EXISTS bloquear_cadastro_menor_13 ON auth.users;
CREATE TRIGGER bloquear_cadastro_menor_13
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.bloquear_cadastro_menor_13();

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 1 linha):
--   select tgname from pg_trigger where tgname = 'bloquear_cadastro_menor_13';
-- Prova sem criar ninguém de verdade (a transação volta atrás):
--   begin;
--   insert into auth.users (id, email, raw_user_meta_data)
--     values (gen_random_uuid(), 'teste-13@futtymock.com',
--             jsonb_build_object('birthdate', to_char(current_date - interval '10 years', 'YYYY-MM-DD')));
--   -- → ERRO: MENOR_DE_13
--   rollback;
-- Reversão:
--   drop trigger if exists bloquear_cadastro_menor_13 on auth.users;
--   drop function if exists public.bloquear_cadastro_menor_13();
-- =====================================================================
