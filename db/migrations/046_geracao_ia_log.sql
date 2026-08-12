-- Futty v2.0 — Migração 046: log de gerações de avatar IA (11-ago, pacote
-- anti-abuso). Matéria-prima do sinal "N contas novas gerando do mesmo IP em
-- 1h" — a auto-freeze e o diagnóstico viral-vs-ataque dependem disto. Só
-- guarda o essencial (user_id, ip, timestamp); sem PII além do ip.
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

CREATE TABLE IF NOT EXISTS public.geracao_ia_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_geracao_ia_log_created_at ON public.geracao_ia_log (created_at);
CREATE INDEX IF NOT EXISTS idx_geracao_ia_log_ip_created_at ON public.geracao_ia_log (ip, created_at);
