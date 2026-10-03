-- =====================================================================
-- Futty v2.0 — Migração 077: o escudo do time (Rodada 29I, bloco 3, 3-out).
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase
-- (DDL é do utilizador) — junto com a 076, a 078 e a 079, antes do "publica".
--
-- POR QUÊ (achado 102 + bancadas aprovadas pelo dono em 2-out, DESIGN/
-- escudo-cores.html e escudo-padroes.html): o time sem logo tinha DOIS
-- controles de cor no painel — "Cor" (4 opções) e "Cor de fundo do avatar"
-- (texto livre) — sem dizer a diferença. Agora há UM controle, "Escudo do
-- time": cor principal + segunda cor + padrão, paleta FIXA de 12 cores nas
-- duas pontas e 6 padrões = 864 escudos, todos legíveis em 84, 36 e 20 px.
-- Reprovados pelo dono e fora daqui: RGB livre, quadriculado, listras finas,
-- pontinhos, gradiente.
--
-- O QUE FAZ:
--   · teams.escudo_cor2    a segunda cor (chave da paleta) — null = escudo de
--                          uma cor só (sólido)
--   · teams.escudo_padrao  solido | faixa | metade | listras | barra | aro —
--                          null = sólido
--   · a cor PRINCIPAL continua em teams.cor (o campo que já existe). A regra
--     antiga dele aceitava só 4 chaves; passa a aceitar as 12 da paleta (e
--     continua aceitando as 4 antigas, que seguem gravadas nos times de hoje:
--     a chave antiga 'verde' sempre foi mostrada como ROXO — ver
--     frontend/src/utils/escudo.js — e segue assim).
--
-- Chaves da paleta (iguais no app e no motor, utils/escudo.js nos dois):
--   roxo #8b5cf6 · azul #3b82f6 · ciano #06b6d4 · gramado #22a060 (o "Verde"
--   da tela; a chave 'verde' é a antiga, que é roxo) · lima #65a30d ·
--   ouro #d4a017 · laranja #ea7317 · vermelho #dc2626 · rosa #db2777 ·
--   vinho #9d174d · grafite #3f4654 · preto #1c1c20
--
-- SEM esta migração: o motor segue funcionando — lê as colunas com
-- tolerância (o time vale "sólido, uma cor"), e gravar a segunda cor, o
-- padrão ou uma cor nova responde "Essa opção ainda não está disponível".
-- =====================================================================

ALTER TABLE IF EXISTS public.teams
  ADD COLUMN IF NOT EXISTS escudo_cor2 text,
  ADD COLUMN IF NOT EXISTS escudo_padrao text;

-- A cor principal: das 4 chaves antigas para as 12 da paleta (as antigas continuam valendo).
ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_cor_check;
ALTER TABLE IF EXISTS public.teams ADD CONSTRAINT teams_cor_check CHECK (cor IN (
  'verde', 'roxo', 'azul', 'ciano', 'gramado', 'lima', 'ouro', 'laranja', 'vermelho', 'rosa', 'vinho', 'grafite', 'preto'
));

ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_escudo_cor2_check;
ALTER TABLE IF EXISTS public.teams ADD CONSTRAINT teams_escudo_cor2_check CHECK (escudo_cor2 IS NULL OR escudo_cor2 IN (
  'roxo', 'azul', 'ciano', 'gramado', 'lima', 'ouro', 'laranja', 'vermelho', 'rosa', 'vinho', 'grafite', 'preto'
));

ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_escudo_padrao_check;
ALTER TABLE IF EXISTS public.teams ADD CONSTRAINT teams_escudo_padrao_check CHECK (escudo_padrao IS NULL OR escudo_padrao IN (
  'solido', 'faixa', 'metade', 'listras', 'barra', 'aro'
));

-- =====================================================================
-- Reversão:
-- ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_escudo_padrao_check;
-- ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_escudo_cor2_check;
-- UPDATE public.teams SET cor = 'verde' WHERE cor NOT IN ('verde', 'azul', 'vermelho', 'preto');
-- ALTER TABLE IF EXISTS public.teams DROP CONSTRAINT IF EXISTS teams_cor_check;
-- ALTER TABLE IF EXISTS public.teams ADD CONSTRAINT teams_cor_check CHECK (cor IN ('verde', 'azul', 'vermelho', 'preto'));
-- ALTER TABLE IF EXISTS public.teams DROP COLUMN IF EXISTS escudo_padrao, DROP COLUMN IF EXISTS escudo_cor2;
-- =====================================================================
