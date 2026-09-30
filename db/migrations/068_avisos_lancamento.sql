-- =====================================================================
-- Futty v2.0 — Migração 068: lista "Avise-me" (Rodada 29B, F, 30-set).
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do
-- utilizador) — junto com as demais pendentes, no dia do "publica".
--
-- POR QUÊ (REDES-SOCIAIS.md): o Futty ainda não está nas lojas e as redes
-- já vão apontar para o site. Quem chega interessado deixa o e-mail e é
-- avisado no dia em que o app sair. Sem login, sem app.
--
-- O QUE FAZ: cria `avisos_lancamento` — um e-mail por linha (único, sempre
-- em minúsculas: o motor normaliza antes de gravar), de onde a pessoa veio
-- (`origem`: utm_source/campanha, ou "site") e quando pediu. Nada mais: nem
-- IP, nem nome, nem aparelho. O consentimento é o próprio pedido (a tela diz,
-- numa linha, para que o e-mail serve e que dá para sair da lista); sair da
-- lista = pedir ao contato@futtyapp.com, que apaga a linha.
--
-- Quem lê e escreve é só o motor (chave secreta): RLS ligada, sem policy —
-- a lista de e-mails nunca é lida por anon/authenticated. O Gabinete (só o
-- super-admin) vê a contagem e exporta o CSV por GET /api/super/gabinete/avise-me.
-- O ENVIO do "chegou nas lojas" NÃO existe ainda: é no dia do lançamento.
--
-- SEM esta migração: POST /api/avise-me responde 503 ("ainda não estamos
-- recebendo e-mails") e a aba do Gabinete diz que falta a migração.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.avisos_lancamento (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 5 AND 254 AND email = lower(email)),
  origem     text NOT NULL DEFAULT 'site' CHECK (char_length(origem) BETWEEN 1 AND 60),
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- O Gabinete lista do mais recente para o mais antigo.
CREATE INDEX IF NOT EXISTS avisos_lancamento_criado_idx
  ON public.avisos_lancamento (criado_em DESC);

-- ---------------------------------------------------------------------
-- Tranca: só o motor (chave secreta) escreve e lê (mesmo padrão da 061).
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS public.avisos_lancamento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.avisos_lancamento FROM PUBLIC;
REVOKE ALL ON TABLE public.avisos_lancamento FROM anon, authenticated;
GRANT ALL ON TABLE public.avisos_lancamento TO service_role;

-- =====================================================================
-- Reversão:
-- DROP TABLE IF EXISTS public.avisos_lancamento;
-- =====================================================================
