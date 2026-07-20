-- =====================================================================
-- Futty v2.0 — Migração 039: campeonatos de N times (modelo novo)
--
-- ESTADO: ALVO FUTURO — **NÃO aplicada**. A v1 do campeonato (Vaga 11B) corre
-- SEM DDL: cada campeonato vive como documento JSON no Storage (bucket privado
-- "campeonatos"), porque o ambiente não permite criar tabelas (só PostgREST +
-- Storage + Auth admin) — mesmo padrão "DDL nenhum" das Vagas 9 e 10.
--
-- A tabela antiga `campeonatos` (026, 2 times fixos) fica INTOCADA — por isso o
-- modelo novo usa nomes próprios (`campeonatos_v2` etc.). Este ficheiro é o
-- destino se/quando quiseres migrar do Storage para tabelas reais: correr o
-- bloco no SQL editor do Supabase (service_role) e trocar utils/campeonatoStore
-- para ler/escrever aqui em vez do Storage. Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.campeonatos_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  nome text NOT NULL,
  formato text NOT NULL DEFAULT 'pontos' CHECK (formato IN ('pontos', 'mata')),
  estado text NOT NULL DEFAULT 'em_curso' CHECK (estado IN ('em_curso', 'terminado')),
  seed bigint,
  campeao_time_id uuid,
  criado_por uuid REFERENCES public.users (id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Times do campeonato (não são os do ranking). jogadores = membros (user_id) +
-- convidados sem app (só nome) — NUNCA entram em users/team_members.
CREATE TABLE IF NOT EXISTS public.campeonato_times (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campeonato_id uuid NOT NULL REFERENCES public.campeonatos_v2 (id) ON DELETE CASCADE,
  nome text NOT NULL,
  kit text,
  cor text,
  ordem int NOT NULL DEFAULT 0,
  jogadores jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Confrontos: pontos (ronda = jornada) ou mata (ronda = fase, bracket).
CREATE TABLE IF NOT EXISTS public.campeonato_confrontos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campeonato_id uuid NOT NULL REFERENCES public.campeonatos_v2 (id) ON DELETE CASCADE,
  ronda int NOT NULL,
  ordem int NOT NULL DEFAULT 0,
  time_a_id uuid,
  time_b_id uuid,
  placar_a int,
  placar_b int,
  jogado boolean NOT NULL DEFAULT false,
  vencedor_id uuid,
  bye boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_campv2_team ON public.campeonatos_v2 (team_id);
CREATE INDEX IF NOT EXISTS idx_camptimes_camp ON public.campeonato_times (campeonato_id);
CREATE INDEX IF NOT EXISTS idx_campconf_camp ON public.campeonato_confrontos (campeonato_id);

-- =====================================================================
-- Reversão:
-- DROP TABLE IF EXISTS public.campeonato_confrontos;
-- DROP TABLE IF EXISTS public.campeonato_times;
-- DROP TABLE IF EXISTS public.campeonatos_v2;
-- (a `campeonatos` de 026 nunca é tocada por esta migração.)
-- =====================================================================
