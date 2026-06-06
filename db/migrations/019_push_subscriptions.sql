-- =====================================================================
-- Futty v2.0 — Migração 019: subscrições de notificações push (Web Push)
-- Uma linha por (utilizador, endpoint do browser/dispositivo).
-- Idempotente. ⚠️ Correr manualmente no Supabase (NÃO corrido pelo código).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id)
    ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions
  ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.push_subscriptions TO service_role;
