-- =====================================================================
-- Futty v2.0 — Migração 071: cadastro só a partir de 18 anos (Rodada 29G, 1-out-2026)
-- Substitui a 062 (que travava em 13 anos). Idempotente. ⚠️ Correr manualmente no SQL Editor do
-- Supabase (DDL é do utilizador).
--
-- POR QUÊ: o Futty passou a ser para maiores de 18 anos, de ponta a ponta (anúncio de aposta em
-- Portugal exige público 18+ nas duas lojas). O cadastro por e-mail vai direto do app para o Supabase
-- Auth (supabase.auth.signUp), sem passar pelo motor, com a data de nascimento no user_metadata. O app
-- já recusa menor de 18 antes de chamar o signUp, e o motor recusa no onboarding (PATCH /api/me e
-- /api/me/onboarding-completo). Esta trava fecha a porta que sobra: quem chamar o signUp à mão com
-- uma data de menor de 18 não ganha conta — o banco recusa a linha em auth.users.
--
-- O QUE FAZ: cria `bloquear_cadastro_menor_18` (mesma lógica da 062, com INTERVAL '18 years') e tira
-- o trigger e a função de 13 anos (`bloquear_cadastro_menor_13`).
-- O QUE NÃO FAZ: não mexe em conta existente (conta com data menor de 18 vê, no app, a tela com
-- "Excluir minha conta"); não exige a data (Google/Apple e as contas criadas pelos scripts de teste
-- não a trazem — nesses casos quem confere é o onboarding); data ilegível não bloqueia (o motor
-- confere de novo).
--
-- SEM esta migração: continua valendo a trava do app e a do motor; o banco ficaria na régua de 13.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.bloquear_cadastro_menor_18()
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
  -- Faz 18 anos hoje = pode. Ainda não fez = não pode.
  IF nascimento > (current_date - INTERVAL '18 years') THEN
    RAISE EXCEPTION 'MENOR_DE_18: o Futty é para maiores de 18 anos'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_18() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_18() FROM anon, authenticated;

-- Troca: o trigger de 13 sai e o de 18 entra (os dois nunca ficam ligados juntos).
DROP TRIGGER IF EXISTS bloquear_cadastro_menor_13 ON auth.users;
DROP FUNCTION IF EXISTS public.bloquear_cadastro_menor_13();

DROP TRIGGER IF EXISTS bloquear_cadastro_menor_18 ON auth.users;
CREATE TRIGGER bloquear_cadastro_menor_18
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.bloquear_cadastro_menor_18();

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 1 linha, e a de 13 nenhuma):
--   select tgname from pg_trigger where tgname in ('bloquear_cadastro_menor_18', 'bloquear_cadastro_menor_13');
-- Prova sem criar ninguém de verdade (a transação volta atrás):
--   begin;
--   insert into auth.users (id, email, raw_user_meta_data)
--     values (gen_random_uuid(), 'teste-18@futtymock.com',
--             jsonb_build_object('birthdate', to_char(current_date - interval '17 years', 'YYYY-MM-DD')));
--   -- → ERRO: MENOR_DE_18
--   rollback;
-- Reversão (volta à régua de 13 da 062):
--   drop trigger if exists bloquear_cadastro_menor_18 on auth.users;
--   drop function if exists public.bloquear_cadastro_menor_18();
--   (e rodar de novo a 062_cadastro_13_anos.sql)
-- =====================================================================
