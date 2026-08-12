-- Futty v2.0 — Migração 045: contador diário de gasto com geração de avatar IA
-- (pacote anti-abuso de custo, 11-ago, ordem do dono). Paraquedas com alerta,
-- nunca teto de vidro: viral legítimo nunca é travado. A chave é a DATA — o
-- teto volta sozinho à meia-noite, sem estado global para alguém limpar.
-- alertas_enviados guarda os degraus (20/50/75/90) já notificados HOJE, para
-- cada um alertar o super-admin só uma vez por dia.
-- Idempotente. ⚠️ Correr manualmente no Supabase (DDL é do utilizador).

CREATE TABLE IF NOT EXISTS public.gasto_ia_diario (
  dia date PRIMARY KEY,
  geracoes integer NOT NULL DEFAULT 0,
  custo_cents integer NOT NULL DEFAULT 0,
  alertas_enviados text[] NOT NULL DEFAULT '{}'
);
