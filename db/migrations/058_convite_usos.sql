-- =====================================================================
-- Futty v2.0 — Migração 058: convite por link reutilizável (Rodada 20,
-- 23-set). Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase
-- (DDL é do utilizador).
--
-- POR QUÊ: o link de convite era de uso único e valia 7 dias (migração 002).
-- Para um time de 20 pessoas num grupo de WhatsApp isso obrigava o dono a
-- gerar 20 links. Decisão (23-set): o link passa a ser como o de grupo do
-- WhatsApp — o MESMO link serve para todo mundo, vale 30 dias, e o admin
-- revoga quando quiser (DELETE /api/teams/:slug/convites/:id já existe).
-- Cada entrada fica registrada aqui (quem entrou por qual link, quando):
-- serve para o contador "N entraram por este link" na tela do time e para
-- o sinal do antiabuso (conta nova que entrou por convite é menos
-- suspeita), que antes lia convites.usado_por — coluna que deixa de ser
-- escrita (fica só como histórico dos convites antigos).
--
-- SEM esta migração aplicada: o link já funciona várias vezes (o motor
-- deixou de gravar usado_por); só não há registro de usos (insert
-- fail-safe, mesmo padrão de foto_hash na 048) e o antiabuso cai na
-- leitura antiga de usado_por.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.convite_usos (
  convite_id uuid NOT NULL REFERENCES public.convites(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  usado_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (convite_id, user_id)
);

-- "Quem entrou por convite nas últimas 24h" (antiabuso) é a outra pergunta.
CREATE INDEX IF NOT EXISTS convite_usos_user_idx
  ON public.convite_usos(user_id, usado_em DESC);

-- RLS/grants no padrão da 049/057: zero para anon/authenticated (sem
-- policy); o backend usa service_role, que ignora RLS.
ALTER TABLE IF EXISTS public.convite_usos ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON public.convite_usos TO service_role;

-- =====================================================================
-- Reversão (perde o registro de quem entrou por qual link):
-- DROP TABLE IF EXISTS public.convite_usos;
-- =====================================================================
