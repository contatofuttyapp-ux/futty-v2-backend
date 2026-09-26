-- =====================================================================
-- Futty v2.0 — Migração 064: compras (Pagamentos P1, 26-set)
-- Idempotente e só acrescenta. ⚠️ Correr manualmente no SQL Editor do
-- Supabase (DDL é do utilizador).
--
-- POR QUÊ: até aqui todo direito de figurinha nascia à mão no Gabinete e
-- não ficava registro de dinheiro nenhum. A compra na loja (App Store /
-- Play Store, via RevenueCat) passa a creditar sozinha — e isso só é
-- seguro com duas coisas no banco:
--   1. uma linha por transação, com índice único (loja, transacao_id):
--      o RevenueCat reenvia webhooks e o app pode "restaurar" a mesma
--      compra — a trava contra crédito em dobro é o índice, não o código;
--   2. soma atómica de créditos (creditar_brilhante): o ler-e-gravar
--      antigo perdia uma soma se duas escritas caíssem no mesmo instante
--      (webhook + restauro, por exemplo).
--
-- SEM esta migração aplicada: o webhook responde 5xx (o RevenueCat
-- reenvia até ela existir — nada se perde), o Gabinete continua a
-- creditar pelo caminho antigo com aviso no log, e o débito da geração
-- cai no ler-e-gravar de sempre.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) Uma linha por transação de loja (ou concessão manual do Gabinete).
--   user_id  NULO só em dois casos: evento de um app_user_id que não é
--            nenhum usuário (gravado como 'ignorada', para auditoria) e
--            conta apagada depois da compra (ON DELETE SET NULL — o
--            registro de dinheiro sobrevive à conta, a pessoa não).
--   produto  NULO só em evento 'ignorada' de um product_id que não vendemos.
--   loja     'outra' guarda eventos de lojas que não vendemos (Stripe,
--            Amazon…) como 'ignorada', sem quebrar o CHECK.
--   preco    na moeda da compra; preco_usd é o que o RevenueCat converte
--            (é a soma que o Gabinete mostra).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compras (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid REFERENCES public.users(id) ON DELETE SET NULL,
  team_id               uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  produto               text CHECK (produto IN ('minha', 'pacote', 'manto')),
  loja                  text NOT NULL CHECK (loja IN ('app_store', 'play_store', 'promo', 'gabinete', 'outra')),
  transacao_id          text NOT NULL,
  transacao_original_id text,
  evento_id             text,
  app_user_id           text,
  moeda                 text,
  preco                 numeric(10,2),
  preco_usd             numeric(10,2),
  ambiente              text NOT NULL DEFAULT 'producao' CHECK (ambiente IN ('producao', 'sandbox')),
  estado                text NOT NULL DEFAULT 'creditada' CHECK (estado IN ('creditada', 'reembolsada', 'ignorada')),
  payload               jsonb,
  criada_em             timestamptz DEFAULT now(),
  creditada_em          timestamptz
);

-- A trava contra crédito em dobro.
CREATE UNIQUE INDEX IF NOT EXISTS compras_loja_transacao_idx ON public.compras (loja, transacao_id);
CREATE INDEX IF NOT EXISTS compras_user_idx ON public.compras (user_id);
CREATE INDEX IF NOT EXISTS compras_team_idx ON public.compras (team_id);
-- O Gabinete soma por mês.
CREATE INDEX IF NOT EXISTS compras_criada_idx ON public.compras (criada_em DESC);

-- ---------------------------------------------------------------------
-- (b) Colunas novas
--   users.rc_app_user_id    o id da pessoa no RevenueCat (usamos o próprio
--                           users.id; fica guardado para auditoria)
--   teams.brilhante_origem  quem ligou o pacote: 'gabinete' | 'app_store' |
--                           'play_store' | 'promo' — o reembolso só desliga
--                           o pacote que ele próprio ligou
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS rc_app_user_id text;
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_origem text;

-- ---------------------------------------------------------------------
-- (c) Soma atómica de créditos. p_qtd negativo debita; nunca fica abaixo
-- de zero. Devolve o saldo novo (NULL se a pessoa não existe).
-- SECURITY DEFINER + EXECUTE só para a service_role: com o EXECUTE aberto,
-- qualquer um com a chave pública chamava /rest/v1/rpc/creditar_brilhante
-- e dava créditos a si próprio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.creditar_brilhante(p_user uuid, p_qtd int)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.users
     SET brilhante_creditos = GREATEST(0, brilhante_creditos + p_qtd)
   WHERE id = p_user
  RETURNING brilhante_creditos;
$$;

REVOKE ALL ON FUNCTION public.creditar_brilhante(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creditar_brilhante(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creditar_brilhante(uuid, int) TO service_role;

-- ---------------------------------------------------------------------
-- (d) RLS + grants — o padrão das migrações 049/054: só a service_role.
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.compras ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.compras FROM PUBLIC;
REVOKE ALL ON TABLE public.compras FROM anon, authenticated;
GRANT ALL ON TABLE public.compras TO service_role;

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER:
--   select count(*) from public.compras;                       -- 0, sem erro
--   select public.creditar_brilhante('00000000-0000-0000-0000-000000000000', 0);  -- NULL
--   select has_function_privilege('anon', 'public.creditar_brilhante(uuid,int)', 'execute');  -- false
-- =====================================================================
