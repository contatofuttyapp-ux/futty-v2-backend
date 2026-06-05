-- =====================================================================
-- Futty v2.0 — Migração 009: denuncias (de comentários ou posts)
-- target_type: 'comentario' | 'post'. motivo: lista fechada.
-- Uma denúncia por reporter/target. Idempotente.
-- =====================================================================

create table if not exists public.denuncias (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('comentario', 'post')),
  target_id   uuid not null,
  reporter_id uuid not null references public.users (id) on delete cascade,
  motivo      text not null check (motivo in (
                'linguagem_inapropriada',
                'spam',
                'conteudo_ofensivo',
                'outro'
              )),
  descricao   text check (char_length(descricao) <= 500),
  resolvida   boolean not null default false,
  created_at  timestamptz not null default now(),
  -- cada utilizador só pode denunciar o mesmo target uma vez
  unique (target_type, target_id, reporter_id)
);

create index if not exists idx_denuncias_target    on public.denuncias (target_type, target_id);
create index if not exists idx_denuncias_resolvida  on public.denuncias (resolvida);

-- =====================================================================
-- RLS — acesso mediado pelo backend (service_role).
-- =====================================================================
alter table public.denuncias enable row level security;
grant all privileges on public.denuncias to service_role;
