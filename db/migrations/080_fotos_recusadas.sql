-- =====================================================================
-- Futty v2.0 — Migração 080: fotos recusadas pela bancada da figurinha
-- (decisão do dono, 6-out). Idempotente e aditiva. ⚠️ Correr manualmente
-- no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: quando o auditor da CABEÇA reprova as duas tentativas de uma
-- geração, a figurinha não sai e ninguém é cobrado (lei: cabeça cortada
-- nunca sai e não cobra). Mas a pessoa podia pedir de novo com a MESMA foto
-- sem limite, e cada pedido custa a fal. Esta tabela guarda a foto recusada
-- pela sua IDENTIDADE (o foto_hash, sha256 dos bytes da foto), não pelo nome
-- do arquivo: foto nova = hash novo = libera.
--
-- SEM esta migração aplicada: o motor segue igual — o bloqueio fica
-- desligado (fail-safe, como o foto_hash da 048) e a recusa só vai para o log.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.fotos_recusadas (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  foto_hash  text NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, foto_hash)
);
