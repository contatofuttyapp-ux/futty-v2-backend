-- =====================================================================
-- Futty v2.0 — Migração 085: cadastro a partir de 13 anos (decisão do dono, 16-out).
-- Substitui a 071 (que travava em 18). Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: o Futty passa a aceitar quem tem 13 anos ou mais. O cadastro por e-mail vai direto do app para o Supabase Auth
-- (supabase.auth.signUp), sem passar pelo motor, com a data de nascimento no user_metadata. O app recusa abaixo de 13 antes do
-- signUp e o motor recusa no onboarding (PATCH /api/me e /api/me/onboarding-completo). Esta trava fecha a porta que sobra: quem
-- chamar o signUp à mão com data abaixo de 13 não ganha conta — o banco recusa a linha em auth.users.
--
-- O QUE FAZ: cria `bloquear_cadastro_menor_13` (mesma lógica da 071, com INTERVAL '13 years') e tira o trigger e a função de 18
-- (`bloquear_cadastro_menor_18`). Os dois nunca ficam ligados juntos.
-- O QUE NÃO FAZ: não mexe em conta existente; não exige a data (Google/Apple e as contas dos scripts de teste não a trazem — nesses
-- casos quem confere é o onboarding); data ilegível não bloqueia (o motor confere de novo).
--
-- SEM esta migração: o app e o motor aceitam 13, mas o cadastro por e-mail de quem tem 13 a 17 anos é recusado pelo BANCO (a 071
-- ainda trava em 18) — a pessoa vê erro no cadastro. Rodar junto com o publica do motor.
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
    RAISE EXCEPTION 'MENOR_DE_IDADE: o Futty é para quem tem 13 anos ou mais'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_13() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bloquear_cadastro_menor_13() FROM anon, authenticated;

-- Troca: o trigger de 18 sai e o de 13 entra.
DROP TRIGGER IF EXISTS bloquear_cadastro_menor_18 ON auth.users;
DROP FUNCTION IF EXISTS public.bloquear_cadastro_menor_18();

DROP TRIGGER IF EXISTS bloquear_cadastro_menor_13 ON auth.users;
CREATE TRIGGER bloquear_cadastro_menor_13
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.bloquear_cadastro_menor_13();

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 1 linha, a de 13; a de 18 nenhuma):
--   select tgname from pg_trigger where tgname in ('bloquear_cadastro_menor_13', 'bloquear_cadastro_menor_18');
-- Prova sem criar ninguém de verdade (cada transação volta atrás):
--   begin;
--   insert into auth.users (id, email, raw_user_meta_data)
--     values (gen_random_uuid(), 'teste-12@futtymock.com',
--             jsonb_build_object('birthdate', to_char(current_date - interval '12 years', 'YYYY-MM-DD')));
--   -- → ERRO: MENOR_DE_IDADE
--   rollback;
--   begin;
--   insert into auth.users (id, email, raw_user_meta_data)
--     values (gen_random_uuid(), 'teste-13@futtymock.com',
--             jsonb_build_object('birthdate', to_char(current_date - interval '13 years', 'YYYY-MM-DD')));
--   -- → INSERT 0 1 (passa)
--   rollback;
-- Reversão (volta à régua de 18): rodar de novo a 071_cadastro_18_anos.sql (ela tira a de 13 e põe a de 18).
-- =====================================================================
