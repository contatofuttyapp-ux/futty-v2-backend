-- =====================================================================
-- Futty v2.0 — Migração 086: a nota passa a ser de 0 a 10 (decisão do dono, 16-out: "uma régua só, de 0 a 10, em todo lugar").
-- Idempotente e aditiva. ⚠️ Correr manualmente no SQL Editor do Supabase (DDL é do utilizador).
--
-- POR QUÊ: o voto era em estrelas, de 0,5 a 5 (votes.nota, migração 017), e a tela mostrava outra conta (estrelas × 2 × 1,15). A régua
-- agora é uma só: a pessoa dá de 0 a 10 (inteiro) e a média que aparece é a média do que foi dado.
--
-- O QUE FAZ:
--   · cria `votes.nota10` (inteiro de 0 a 10) e preenche cada voto antigo com estrelas × 2 (0,5 → 1 … 5 → 10). É a nota que o motor novo lê.
--   · a coluna antiga `nota` (estrelas) FICA, espelhada por um gatilho nos dois sentidos: quem grava `nota10` (motor novo) acerta `nota`
--     (÷ 2) e quem grava `nota` (motor antigo, até o publica terminar) acerta `nota10` (× 2). Por isso a ordem não importa: o motor antigo
--     continua certo depois desta migração e o motor novo funciona antes e depois dela.
--   · o CHECK da coluna antiga passa a aceitar 0 (é o espelho do 0 da régua nova: 0 ÷ 2).
-- O QUE NÃO FAZ: não muda nenhum voto de verdade (só traduz de régua); não mexe em team_members.nota_interna (é o texto "Razão (só você
-- vê)" do admin, não é nota); não mexe nos sorteios já gravados (o número de cada jogador no sorteio é uma foto daquele dia — as telas leem
-- o sorteio antigo × 2 e o motor novo grava os novos já na régua de 10).
--
-- Rodar de novo não estraga nada: só preenche quem estiver sem `nota10`.
-- =====================================================================

alter table public.votes add column if not exists nota10 smallint;

-- O espelho entre as duas colunas. BEFORE: corre antes do NOT NULL e dos CHECKs, então quem grava só uma das duas passa. Ligado ANTES de preencher:
-- um voto que o motor antigo grave durante a migração já nasce com as duas colunas.
create or replace function public.votes_espelhar_nota()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.nota10 is null then
      new.nota10 := round(new.nota * 2)::smallint;
    else
      new.nota := new.nota10 / 2.0;
    end if;
  elsif new.nota10 is distinct from old.nota10 then
    new.nota := new.nota10 / 2.0;
  elsif new.nota is distinct from old.nota then
    new.nota10 := round(new.nota * 2)::smallint;
  end if;
  return new;
end;
$$;

drop trigger if exists votes_espelhar_nota on public.votes;
create trigger votes_espelhar_nota
  before insert or update on public.votes
  for each row execute function public.votes_espelhar_nota();

update public.votes set nota10 = round(nota * 2)::smallint where nota10 is null;

alter table public.votes alter column nota10 set not null;
alter table public.votes drop constraint if exists votes_nota10_check;
alter table public.votes add constraint votes_nota10_check check (nota10 between 0 and 10);

alter table public.votes drop constraint if exists votes_nota_check;
alter table public.votes add constraint votes_nota_check
  check (nota >= 0 and nota <= 5 and mod((nota * 10)::int, 5) = 0);

-- O PostgREST passa a enxergar a coluna nova na hora.
notify pgrst, 'reload schema';
