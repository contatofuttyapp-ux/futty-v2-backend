-- 035 — Resenha = rede social: TODOS os membros postam por OMISSÃO.
--
-- Inverte a semântica de team_members.pode_postar:
--   ANTES: default false; postar exigia pode_postar=true (opt-in do admin).
--   AGORA: default true; pode_postar=false passa a ser o SILENCIADOR explícito do admin.
--
-- Reconfirmado ANTES de aplicar (read-only, 2026-07-18): 0 grants existentes (nenhum
-- membro a true), 20 membros não-admin a false (só por defeito), 4 admins. Logo NÃO há
-- estado explícito a perder — virar os 20 para true é seguro.
--
-- NOTA: nenhuma mudança de CÓDIGO é precisa. O backend (routes/feed.js) e o frontend
-- (equipasParaPostar) já dizem "posta se admin OU pode_postar"; com o default a true isso
-- passa a significar "todos postam, exceto quem o admin silenciar (pode_postar=false)".
-- O toggle "Pode postar" do AdminPanel continua a ler certo (marcado = posta; desmarcado
-- = silenciado) — só o DEFAULT dos novos membros muda.

alter table public.team_members
  alter column pode_postar set default true;

-- Vira os membros existentes (false só por defeito) para true. (Afecta ~20 linhas.)
update public.team_members set pode_postar = true where pode_postar = false;
