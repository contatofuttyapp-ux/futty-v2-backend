-- =====================================================================
-- Futty v2.0 — Migração 060: a foto do Google não é figurinha (Hotfix 26)
-- Idempotente. ⚠️ Correr manualmente no SQL Editor do Supabase.
--
-- POR QUÊ: o trigger handle_new_user (001) copiava
-- raw_user_meta_data->>'avatar_url' — a foto de perfil da conta Google —
-- para public.users.avatar_url. O motor decidia "já tem figurinha IA" por
-- avatar_url <> foto_url; então quem entrava com o Google parecia ter
-- figurinha sem nunca ter gerado: "Trocar foto" gravava a foto nova em
-- foto_url e o card (avatar_url) nunca mudava. O motor já não decide por
-- comparação de URL (utils/figurinhaRegra.js: decide pelo nome do arquivo)
-- e funciona igual antes e depois desta migração; ela limpa a causa e
-- conserta quem já foi atingido.
--
-- 1) handle_new_user passa a criar a linha só com id, email e nome.
--    avatar_url nasce NULL e só o motor o escreve (a foto que a pessoa
--    sobe, ou uma figurinha gerada por nós).
--
-- 2) Reparo: avatar_url que NÃO é nosso volta a ser a foto da pessoa
--    (foto_url) — ou NULL, se ela ainda não subiu foto (o app mostra a
--    silhueta). "Nosso" são os dois buckets do app: `avatars` (fotos e
--    figurinhas) e `kits` (as silhuetas genéricas, que as contas da demo
--    usam como avatar_url). O caminho relativo /public/avatares/ são os
--    avatares migrados da V1, servidos pelo próprio motor.
-- =====================================================================

-- PRÉVIA (opcional, só lê): quem o reparo vai alcançar. Hoje deve listar
-- só a conta que entrou com o Google.
--   select id, email, left(avatar_url, 45) as avatar_url, foto_url is not null as tem_foto
--     from public.users
--    where avatar_url is not null
--      and avatar_url not like '%/storage/v1/object/public/avatars/%'
--      and avatar_url not like '%/storage/v1/object/public/kits/%'
--      and avatar_url not like '/public/avatares/%';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, nome)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nome', new.raw_user_meta_data ->> 'full_name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

update public.users
   set avatar_url = foto_url
 where avatar_url is not null
   and avatar_url not like '%/storage/v1/object/public/avatars/%'
   and avatar_url not like '%/storage/v1/object/public/kits/%'
   and avatar_url not like '/public/avatares/%';

-- =====================================================================
-- CONFERIR DEPOIS DE CORRER:
--   1) deve devolver 0 (ninguém com avatar_url de fora):
--      select count(*) from public.users
--       where avatar_url is not null
--         and avatar_url not like '%/storage/v1/object/public/avatars/%'
--         and avatar_url not like '%/storage/v1/object/public/kits/%'
--         and avatar_url not like '/public/avatares/%';
--   2) deve devolver false (o trigger já não copia avatar_url):
--      select prosrc like '%avatar_url%' from pg_proc where proname = 'handle_new_user';
-- =====================================================================
