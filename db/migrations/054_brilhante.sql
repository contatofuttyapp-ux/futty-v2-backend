-- =====================================================================
-- Futty v2.0 — Migração 054: Figurinha Brilhante (SPEC-FIGURINHA-3, 22-set)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do
-- utilizador).
--
-- POR QUÊ: a figurinha de IA era o item mais caro do app e nascia de graça
-- em todo cadastro (US$0,05-0,11 cada). A decisão do dono (22-set) separa
-- duas coisas: a figurinha COMUM (a foto da pessoa na moldura, custo zero,
-- grátis para sempre) e a Figurinha BRILHANTE (arte IA na receita V6, paga
-- ou presente único de quem cria um time). Toda geração passa a nascer
-- paga — `LIMITES_IA` por plano e `users.avatar_ia_mes` deixam de mandar.
--
-- SEM esta migração aplicada: o motor funciona e NINGUÉM tem direito de
-- gerar Brilhante (utils/direitoBrilhante.js devolve `{ fonte: null }` ao
-- ver a coluna/tabela em falta, com aviso no log — fail-safe, o lado
-- seguro do erro é não gastar dinheiro). O resto do app fica igual: a
-- figurinha comum, a foto, o Início e o Ranking não dependem de nada disto.
-- O presente do criador de time também falha em silêncio (o time é criado
-- na mesma, sem o crédito).
--
-- As colunas antigas (users.plan, avatar_ia_mes, avatar_ia_reset,
-- avatar_ia_creditos) NÃO são apagadas aqui: `plan` ainda aparece no
-- Gabinete e apagar coluna é irreversível. Ficam para a limpeza final.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) Direitos da pessoa
--   brilhante_creditos  Minha Brilhante dá +2; presente do criador +1
--   presente_criador_em quando o presente foi dado (uma vez na vida)
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS brilhante_creditos integer NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.users
  ADD COLUMN IF NOT EXISTS presente_criador_em timestamptz;

-- ---------------------------------------------------------------------
-- (b) O pacote do time
--   brilhante_ativo   o time comprou o pacote (R$49,90)
--   brilhante_kit     um dos 5 ids de KITS_IA — o uniforme de TODOS
--   brilhante_limite  25 jogadores (tecto do pacote)
--   manto_proprio     o time comprou o manto (+R$49,90) — fase 2
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_ativo boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_kit text;
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_ativado_em timestamptz;
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS brilhante_limite integer NOT NULL DEFAULT 25;
ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS manto_proprio boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- (c) Quem já gastou a Brilhante do pacote de cada time. A chave primária
-- (team_id, user_id) É a regra da secção 5 da spec: uma Brilhante por
-- pessoa por time. Contar as linhas deste time dá o uso contra o limite
-- de 25. `custo_cents` guarda o custo REAL da fal (a mesma verdade que o
-- gasto_ia_diario) para o Gabinete somar por time no bloco 2.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brilhantes_time (
  team_id    uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kit_id     text NOT NULL,
  avatar_url text,
  custo_cents integer,
  gerada_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- "Quantas já gerei neste time?" e "esta pessoa já tem?" são as duas
-- perguntas da secção 5 — a PK serve a segunda, este índice a primeira.
CREATE INDEX IF NOT EXISTS brilhantes_time_team_idx ON public.brilhantes_time(team_id);

-- ---------------------------------------------------------------------
-- (d) Pedidos de ativação. Enquanto a compra na loja não existe, o botão
-- faz uma coisa verdadeira: grava o pedido, e o super-admin ativa à mão
-- no Gabinete (bloco 2). `team_id` é nulo em 'minha' (não é de time).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pedidos_ativacao (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  produto      text NOT NULL CHECK (produto IN ('pacote', 'manto', 'minha')),
  estado       text NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'ativado', 'recusado')),
  criado_em    timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz
);

CREATE INDEX IF NOT EXISTS pedidos_ativacao_estado_idx ON public.pedidos_ativacao(estado, criado_em DESC);
CREATE INDEX IF NOT EXISTS pedidos_ativacao_user_idx ON public.pedidos_ativacao(user_id);

-- UMA pendente por pessoa/produto/time (secção 4 do pedido do bloco 1).
-- Índice único PARCIAL: só as pendentes colidem — depois de resolvida, a
-- pessoa pode pedir de novo. `coalesce` porque em 'minha' o team_id é NULL
-- e NULL nunca colide com NULL num índice único normal.
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_ativacao_uma_pendente_idx
  ON public.pedidos_ativacao (user_id, produto, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE estado = 'pendente';

-- ---------------------------------------------------------------------
-- (e) RLS + grants — o padrão das migrações 049/053: o backend fala com o
-- banco pela service_role (que ignora RLS); anon/authenticated NUNCA tocam
-- estas tabelas direto. A 049 já revogou tudo em `public` e pôs os DEFAULT
-- PRIVILEGES a revogar em tabelas futuras, mas isto aqui é explícito para
-- não depender de qual role correu a 049 nem da ordem das migrações.
-- RLS ligada sem policy nenhuma = ninguém lê nem escreve (menos a
-- service_role, por natureza). Defesa em profundidade, como na 049.
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.brilhantes_time   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.pedidos_ativacao  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.brilhantes_time  FROM PUBLIC;
REVOKE ALL ON TABLE public.brilhantes_time  FROM anon, authenticated;
REVOKE ALL ON TABLE public.pedidos_ativacao FROM PUBLIC;
REVOKE ALL ON TABLE public.pedidos_ativacao FROM anon, authenticated;

GRANT ALL ON TABLE public.brilhantes_time  TO service_role;
GRANT ALL ON TABLE public.pedidos_ativacao TO service_role;

-- ---------------------------------------------------------------------
-- (f) Conta demo das lojas: 2 créditos, para o revisor ver o produto
-- completo (secção 7 da spec). Não falha se a conta não existir.
-- ---------------------------------------------------------------------
UPDATE public.users
   SET brilhante_creditos = GREATEST(brilhante_creditos, 2)
 WHERE email = 'demo-loja@futtymock.com';

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER (deve devolver 2 linhas e 2 tabelas):
--   select column_name from information_schema.columns
--    where table_name='users' and column_name in ('brilhante_creditos','presente_criador_em');
--   select table_name from information_schema.tables
--    where table_schema='public' and table_name in ('brilhantes_time','pedidos_ativacao');
-- =====================================================================
