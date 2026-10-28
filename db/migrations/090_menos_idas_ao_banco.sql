-- =====================================================================
-- Futty v2.0 — Migração 090: o Início, a Resenha e o Ranking numa ida só ao banco.
-- Idempotente (create or replace). ⚠️ Rodar à mão no SQL Editor do Supabase (o DDL é do dono).
--
-- POR QUÊ: medido em produção, cada consulta ao Supabase custa ~32 ms dentro dele + ~30 ms de ida e volta, e o dobro quando várias
-- chegam juntas. O caminho até o banco está limpo (DNS 1 ms, TLS 8 ms, datacenter GRU, ligação quente valendo); o que pesa é o NÚMERO
-- de perguntas: o /api/inicio fazia ~28, em ondas, e levava ~1 s; a Resenha ~12 e o Ranking ~10. Estas funções fazem as mesmas
-- leituras DENTRO do banco e devolvem tudo num JSON só — uma ida por tela.
--
-- O QUE FAZ: cria public.inicio_da_pessoa(uid, agora), public.feed_da_pessoa(uid, time, quantos, cursor, no_instante),
-- public.ranking_do_time(uid, slug) e a auxiliar public.vinculos_da_pessoa_json(uid). Elas devolvem as MESMAS linhas que o motor lia uma a
-- uma (mesmas colunas, mesmos filtros, mesma ordem), cada grupo numa chave; a montagem da resposta continua no motor, com as regras de
-- sempre (estado do jogo, lista aberta, nome público, fuso, pontos do ranking…) — nenhuma regra do app mora aqui. Só leem: não gravam nada.
-- Segurança: security definer com search_path fixo, dona postgres, e só o service_role (a chave do motor) executa; anon e
-- authenticated não.
--
-- A ORDEM NÃO QUEBRA NADA: o motor publicado antes desta migração percebe que a função não existe e segue pelo caminho antigo (uma
-- linha de aviso no log); depois dela, passa a usar a função em até 1 minuto. Rodar de novo não estraga nada.
-- =====================================================================

-- Os vínculos da pessoa (team_members + o time embutido), por created_at — a mesma leitura que o Início e a Resenha dividem no motor.
-- Todo "embutido" (o time do vínculo, o jogo da presença, a pessoa do elenco…) é uma subconsulta POR LINHA, como o PostgREST faz: a ordem
-- das linhas é a da tabela de fora, nunca a que um join escolheria.
create or replace function public.vinculos_da_pessoa_json(p_uid uuid)
returns json
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((
    select json_agg(json_build_object(
      'team_id', tm.team_id, 'role', tm.role, 'ausente_proximo', tm.ausente_proximo, 'created_at', tm.created_at,
      'teams', (select json_build_object(
        'id', t.id, 'nome', t.nome, 'slug', t.slug, 'cor', t.cor, 'cidade', t.cidade, 'criado_por', t.criado_por, 'created_at', t.created_at,
        'logo_url', t.logo_url, 'cor_fundo', t.cor_fundo, 'modo_visibilidade', t.modo_visibilidade, 'brilhante_ativo', t.brilhante_ativo,
        'brilhante_kit', t.brilhante_kit, 'brilhante_limite', t.brilhante_limite, 'manto_proprio', t.manto_proprio,
        'revotar_pedido_em', t.revotar_pedido_em, 'fuso', t.fuso, 'escudo_cor2', t.escudo_cor2, 'escudo_padrao', t.escudo_padrao,
        'jogadores_por_time', t.jogadores_por_time, 'presenca_fundador_ate', t.presenca_fundador_ate)
        from teams t where t.id = tm.team_id))
      order by tm.created_at)
    from team_members tm
    where tm.user_id = p_uid), '[]'::json)
$fn$;

alter function public.vinculos_da_pessoa_json(uuid) owner to postgres;
revoke all on function public.vinculos_da_pessoa_json(uuid) from public;
revoke all on function public.vinculos_da_pessoa_json(uuid) from anon, authenticated;
grant execute on function public.vinculos_da_pessoa_json(uuid) to service_role;

create or replace function public.inicio_da_pessoa(p_uid uuid, p_agora timestamptz default now())
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_times uuid[];          -- os times da pessoa que existem (os vínculos com time), na ordem dos vínculos
  v_principal uuid;        -- o 1º deles: o time principal do Início
  v_proximo_id uuid;       -- o próximo jogo (o 1º que ainda não acabou, por data)
  v_proximo_time uuid;
  v_campeonato uuid;
  v_slots json;
  v_resultado json;
begin
  select coalesce(array_agg(tm.team_id order by tm.created_at), '{}'), (array_agg(tm.team_id order by tm.created_at))[1]
    into v_times, v_principal
    from team_members tm join teams t on t.id = tm.team_id
   where tm.user_id = p_uid;

  select g.id, g.team_id into v_proximo_id, v_proximo_time
    from games g
   where g.team_id = any (v_times)
     and (g.data >= p_agora or g.data is null)
     and not coalesce(g.cancelado, false)
     and coalesce(g.status, '') not in ('terminado', 'cancelado')
   order by g.data asc nulls last
   limit 1;

  select c.id into v_campeonato from campeonatos c where c.team_id = v_principal order by c.criado_em desc limit 1;

  -- As figurinhas pagas antigas: a tabela não nasceu numa migração e pode não existir; sem ela, o motor também lia "nada".
  if to_regclass('public.user_avatar_slots') is not null then
    execute 'select coalesce(json_agg(json_build_object(''kit_id'', s.kit_id)), ''[]''::json) from public.user_avatar_slots s where s.user_id = $1'
      into v_slots using p_uid;
  end if;

  select json_build_object(
    'versao', 1,
    -- ── os vínculos (team_members + o time embutido), por created_at ──
    'vinculos', public.vinculos_da_pessoa_json(p_uid),
    'so_organiza', coalesce((select json_agg(tm.team_id) from team_members tm where tm.user_id = p_uid and tm.joga = false), '[]'::json),
    -- ── o "me" ──
    'perfil', (select json_build_object(
        'id', u.id, 'nome', u.nome, 'email', u.email, 'avatar_url', u.avatar_url, 'foto_url', u.foto_url, 'nome_jogador', u.nome_jogador,
        'cor_preferida', u.cor_preferida, 'telefone', u.telefone, 'avatar_ia_creditos', u.avatar_ia_creditos, 'cor_frame', u.cor_frame,
        'fundo_figurinha', u.fundo_figurinha, 'plan', u.plan, 'avatar_ia_mes', u.avatar_ia_mes, 'avatar_ia_reset', u.avatar_ia_reset,
        'is_super_admin', u.is_super_admin, 'birthdate', u.birthdate, 'kit_ativo', u.kit_ativo, 'mostrar_rosto_publico', u.mostrar_rosto_publico,
        'avatar_generico', u.avatar_generico, 'figurinha_status', u.figurinha_status, 'figurinha_status_em', u.figurinha_status_em,
        'foto_original_url', u.foto_original_url)
      from users u where u.id = p_uid),
    'me_presencas', coalesce((
      select json_agg(json_build_object('game_id', gp.game_id,
        'games', (select json_build_object('data', g.data, 'status', g.status, 'cancelado', g.cancelado) from games g where g.id = gp.game_id)))
      from game_players gp
      where gp.user_id = p_uid and gp.confirmado = true), '[]'::json),
    'gols', coalesce((select json_agg(json_build_object('gols', gj.gols)) from gols_jogadores gj where gj.user_id = p_uid), '[]'::json),
    'votos_recebidos', coalesce((select json_agg(json_build_object('nota10', v.nota10)) from votes v where v.para_user_id = p_uid), '[]'::json),
    'slots', v_slots,
    'brilhante_um', coalesce((select json_agg(json_build_object('user_id', b.user_id))
      from (select b0.user_id from brilhantes_time b0 where b0.user_id = p_uid limit 1) b), '[]'::json),
    'historico_um', coalesce((select json_agg(json_build_object('id', h.id))
      from (select h0.id from user_avatar_historico h0 where h0.user_id = p_uid limit 1) h), '[]'::json),
    -- Os jogos dos times com presença de fundador (o motor filtra quais contam).
    'fundador_jogos', coalesce((
      select json_agg(json_build_object('id', g.id, 'team_id', g.team_id, 'data', g.data, 'status', g.status, 'cancelado', g.cancelado))
      from games g
      where g.team_id in (select tm.team_id from team_members tm join teams t on t.id = tm.team_id
                           where tm.user_id = p_uid and t.presenca_fundador_ate is not null)), '[]'::json),
    -- ── os times: o badge de pedidos e o "Seu time" ──
    'pedidos_pendentes_admin', coalesce((
      select json_agg(json_build_object('team_id', r.team_id))
      from team_join_requests r
      where r.status = 'pending'
        and r.team_id in (select tm.team_id from team_members tm join teams t on t.id = tm.team_id where tm.user_id = p_uid and tm.role = 'admin')), '[]'::json),
    -- ── a votação ──
    'meus_votos', coalesce((
      select json_agg(json_build_object('team_id', v.team_id, 'para_user_id', v.para_user_id, 'updated_at', v.updated_at))
      from votes v
      where v.de_user_id = p_uid and v.team_id in (select tm.team_id from team_members tm where tm.user_id = p_uid)), '[]'::json),
    -- Os jogos dos times em que a pessoa esteve confirmada (o motor confere quais já aconteceram e quem jogou junto).
    'jogos_votacao', coalesce((
      select json_agg(json_build_object('id', g.id, 'team_id', g.team_id, 'data', g.data, 'status', g.status, 'cancelado', g.cancelado,
        'game_players', coalesce((select json_agg(json_build_object('user_id', gp.user_id, 'confirmado', gp.confirmado))
                                  from game_players gp where gp.game_id = g.id), '[]'::json)))
      from games g
      where g.team_id = any (v_times)
        and exists (select 1 from game_players eu where eu.game_id = g.id and eu.user_id = p_uid and eu.confirmado = true)), '[]'::json),
    -- ── os jogos do Início: os que vão acontecer (por data) + os 8 últimos de cada time ──
    'jogos_proximos', coalesce((
      select json_agg(json_build_object('id', g.id, 'team_id', g.team_id, 'data', g.data, 'local', g.local, 'status', g.status,
        'sorteio_realizado', g.sorteio_realizado, 'cancelado', g.cancelado, 'campeao_time_index', g.campeao_time_index,
        'time_vencedor', g.time_vencedor, 'seed', g.times_resultado -> 'seed',
        'game_players', coalesce((select json_agg(json_build_object('user_id', gp.user_id, 'confirmado', gp.confirmado))
                                  from game_players gp where gp.game_id = g.id), '[]'::json),
        'sorteio_em', g.sorteio_em, 'chamados', g.chamados)
        order by g.data asc nulls last)
      from games g
      where g.team_id = any (v_times) and (g.data >= p_agora or g.data is null)), '[]'::json),
    'jogos_recentes', coalesce((
      select json_object_agg(x.team_id, x.jogos)
      from (
        select tid as team_id, coalesce((
          select json_agg(json_build_object('id', g.id, 'team_id', g.team_id, 'data', g.data, 'local', g.local, 'status', g.status,
            'sorteio_realizado', g.sorteio_realizado, 'cancelado', g.cancelado, 'campeao_time_index', g.campeao_time_index,
            'time_vencedor', g.time_vencedor, 'seed', g.times_resultado -> 'seed',
            'game_players', coalesce((select json_agg(json_build_object('user_id', gp.user_id, 'confirmado', gp.confirmado))
                                      from game_players gp where gp.game_id = g.id), '[]'::json),
            'sorteio_em', g.sorteio_em, 'chamados', g.chamados)
            order by g.data desc)
          from (select * from games g0 where g0.team_id = tid and g0.data < p_agora order by g0.data desc limit 8) g), '[]'::json) as jogos
        from (select distinct unnest(v_times) as tid) ts
      ) x), '{}'::json),
    'minha_fila', coalesce((select json_agg(json_build_object('game_id', e.game_id, 'posicao', e.posicao)) from rsvp_espera e where e.user_id = p_uid), '[]'::json),
    -- ── os pedidos de entrada da pessoa ──
    'pedidos', coalesce((
      select json_agg(json_build_object('id', r.id, 'status', r.status, 'updated_at', r.updated_at,
        'teams', (select json_build_object('id', t.id, 'nome', t.nome, 'slug', t.slug, 'cor', t.cor, 'logo_url', t.logo_url) from teams t where t.id = r.team_id))
        order by r.updated_at desc)
      from team_join_requests r
      where r.user_id = p_uid and r.status in ('approved', 'rejected', 'pending')), '[]'::json),
    -- ── o time principal: a votação dele e o campeonato antigo ──
    'principal', v_principal,
    'membros_principal', case when v_principal is null then null else coalesce((
      select json_agg(json_build_object('user_id', tm.user_id)) from team_members tm where tm.team_id = v_principal), '[]'::json) end,
    'campeonato', case when v_principal is null then null else json_build_object(
      'campeonato', (select to_json(c) from campeonatos c where c.id = v_campeonato),
      'jornadas', case when v_campeonato is null then null else coalesce((
        select json_agg(to_json(j) order by j.numero asc) from campeonato_jornadas j where j.campeonato_id = v_campeonato), '[]'::json) end) end,
    -- ── a presença do próximo jogo ──
    'rsvp', case when v_proximo_id is null then null else json_build_object(
      'game_id', v_proximo_id,
      'game', (select (to_jsonb(g) || jsonb_build_object('teams', (
          select jsonb_build_object('id', t.id, 'slug', t.slug, 'nome', t.nome, 'cor', t.cor, 'cidade', t.cidade, 'logo_url', t.logo_url,
            'fuso', t.fuso, 'escudo_cor2', t.escudo_cor2, 'escudo_padrao', t.escudo_padrao, 'jogadores_por_time', t.jogadores_por_time,
            'presenca_fundador_ate', t.presenca_fundador_ate)
          from teams t where t.id = g.team_id)))::json
        from games g where g.id = v_proximo_id),
      'membros', coalesce((
        select json_agg(json_build_object('users', (select json_build_object(
          'id', u.id, 'nome', u.nome, 'nome_jogador', u.nome_jogador, 'avatar_url', u.avatar_url, 'avatar_generico', u.avatar_generico)
          from users u where u.id = tm.user_id)))
        from team_members tm where tm.team_id = v_proximo_time), '[]'::json),
      'respostas', coalesce((select json_agg(json_build_object('user_id', r.user_id, 'status', r.status)) from rsvp_respostas r where r.game_id = v_proximo_id), '[]'::json),
      'espera', coalesce((select json_agg(json_build_object('user_id', e.user_id, 'posicao', e.posicao) order by e.posicao asc)
        from rsvp_espera e where e.game_id = v_proximo_id), '[]'::json),
      'organizam', coalesce((select json_agg(tm.user_id) from team_members tm where tm.team_id = v_proximo_time and tm.joga = false), '[]'::json),
      'elenco', coalesce((select json_agg(json_build_object('user_id', gp.user_id, 'confirmado', gp.confirmado)) from game_players gp where gp.game_id = v_proximo_id), '[]'::json)
    ) end,
    -- ── o direito à figurinha ──
    'brilhante_creditos', (select u.brilhante_creditos from users u where u.id = p_uid),
    'brilhante_membros', coalesce((
      select json_agg(json_build_object('team_id', tm.team_id, 'teams', (select json_build_object('id', t.id, 'brilhante_ativo', t.brilhante_ativo,
        'brilhante_kit', t.brilhante_kit, 'brilhante_limite', t.brilhante_limite, 'brilhante_por_jogador', t.brilhante_por_jogador)
        from teams t where t.id = tm.team_id)))
      from team_members tm
      where tm.user_id = p_uid and exists (select 1 from teams t where t.id = tm.team_id and t.brilhante_ativo = true)), '[]'::json),
    'brilhante_times', coalesce((
      select json_object_agg(t.id, json_build_object(
        'minha', (select json_build_object('user_id', b.user_id, 'geracoes', b.geracoes, 'custo_cents', b.custo_cents)
                  from brilhantes_time b where b.team_id = t.id and b.user_id = p_uid),
        'ocupadas', (select count(*) from brilhantes_time b where b.team_id = t.id),
        'organizam', coalesce((select json_agg(o.user_id) from team_members o where o.team_id = t.id and o.joga = false), '[]'::json),
        'do_organizador', (select count(*) from brilhantes_time b where b.team_id = t.id
                             and b.user_id in (select o.user_id from team_members o where o.team_id = t.id and o.joga = false))))
      from teams t
      where t.brilhante_ativo = true and t.brilhante_kit is not null
        and t.id in (select tm.team_id from team_members tm where tm.user_id = p_uid)), '{}'::json),
    'pedidos_brilhante', coalesce((
      select json_agg(json_build_object('id', p.id, 'team_id', p.team_id, 'produto', p.produto, 'estado', p.estado,
        'criado_em', p.criado_em, 'resolvido_em', p.resolvido_em, 'motivo', p.motivo) order by p.criado_em desc)
      from pedidos_ativacao p
      where p.user_id = p_uid and p.estado in ('pendente', 'recusado')
        and (p.estado = 'pendente' or p.resolvido_em >= p_agora - interval '720 hours')), '[]'::json)
  ) into v_resultado;

  return v_resultado;
end
$fn$;

alter function public.inicio_da_pessoa(uuid, timestamptz) owner to postgres;
revoke all on function public.inicio_da_pessoa(uuid, timestamptz) from public;
revoke all on function public.inicio_da_pessoa(uuid, timestamptz) from anon, authenticated;
grant execute on function public.inicio_da_pessoa(uuid, timestamptz) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- A Resenha (/api/feed) numa ida só: os times da pessoa, os bloqueios, a página de jogos e de posts (as mesmas consultas, com o
-- mesmo filtro, a mesma ordem e o mesmo "um a mais" da paginação, mais os do instante do cursor) e, de TODOS esses candidatos, as
-- mídias, os comentários, as reações e as pessoas citadas. O motor escolhe a página e monta os cartões como antes; o que veio a mais
-- (candidato que não entrou na página) ele simplesmente não usa.
-- p_team: o filtro de um time (null = todos); p_quantos: quantos de cada lista; p_cursor_em: o instante do cursor (null = a 1ª página);
-- p_no_instante: o cursor diz qual foi o último item (lê também os do mesmo instante).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.feed_da_pessoa(p_uid uuid, p_team uuid, p_quantos integer, p_cursor_em timestamptz, p_no_instante boolean)
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_times uuid[];
  v_jogos json;
  v_posts json;
  v_jogos_inst json;
  v_posts_inst json;
  v_ids_jogos uuid[];
  v_ids_posts uuid[];
  v_ids_jogos_inst uuid[];
  v_ids_posts_inst uuid[];
  v_resultado json;
begin
  select coalesce(array_agg(tm.team_id), '{}') into v_times
    from team_members tm
   where tm.user_id = p_uid and exists (select 1 from teams t where t.id = tm.team_id) and (p_team is null or tm.team_id = p_team);

  -- Jogo que entra na Resenha: tem resultado (campeão ou empate) ou só a foto do campeão.
  select coalesce(array_agg(x.id), '{}'), coalesce(json_agg(json_build_object('id', x.id, 'team_id', x.team_id, 'data', x.data, 'local', x.local,
      'times_resultado', x.times_resultado, 'campeao_time_index', x.campeao_time_index, 'time_vencedor', x.time_vencedor, 'placar_a', x.placar_a,
      'placar_b', x.placar_b, 'campeao_foto_url', x.campeao_foto_url, 'artilheiro_user_id', x.artilheiro_user_id, 'artilheiro_gols', x.artilheiro_gols,
      'destaque_user_id', x.destaque_user_id, 'destaque_titulo', x.destaque_titulo, 'rodada_user_id', x.rodada_user_id,
      'rodada_foto_url', x.rodada_foto_url, 'created_at', x.created_at) order by x.created_at desc, x.id desc), '[]'::json)
    into v_ids_jogos, v_jogos
    from (select g.* from games g
           where g.team_id = any (v_times)
             and (g.campeao_time_index >= 0 or g.time_vencedor = 'empate' or g.campeao_foto_url is not null)
             and (p_cursor_em is null or g.created_at < p_cursor_em)
           order by g.created_at desc, g.id desc limit p_quantos) x;

  select coalesce(array_agg(x.id), '{}'), coalesce(json_agg(json_build_object('id', x.id, 'team_id', x.team_id, 'author_id', x.author_id,
      'body', x.body, 'tipo', x.tipo, 'conteudo', x.conteudo, 'created_at', x.created_at) order by x.created_at desc, x.id desc), '[]'::json)
    into v_ids_posts, v_posts
    from (select p.* from feed_posts p
           where p.team_id = any (v_times) and (p_cursor_em is null or p.created_at < p_cursor_em)
           order by p.created_at desc, p.id desc limit p_quantos) x;

  if p_no_instante and p_cursor_em is not null then
    select coalesce(array_agg(g.id), '{}'), coalesce(json_agg(json_build_object('id', g.id, 'team_id', g.team_id, 'data', g.data, 'local', g.local,
        'times_resultado', g.times_resultado, 'campeao_time_index', g.campeao_time_index, 'time_vencedor', g.time_vencedor, 'placar_a', g.placar_a,
        'placar_b', g.placar_b, 'campeao_foto_url', g.campeao_foto_url, 'artilheiro_user_id', g.artilheiro_user_id, 'artilheiro_gols', g.artilheiro_gols,
        'destaque_user_id', g.destaque_user_id, 'destaque_titulo', g.destaque_titulo, 'rodada_user_id', g.rodada_user_id,
        'rodada_foto_url', g.rodada_foto_url, 'created_at', g.created_at)), '[]'::json)
      into v_ids_jogos_inst, v_jogos_inst
      from games g
     where g.team_id = any (v_times)
       and (g.campeao_time_index >= 0 or g.time_vencedor = 'empate' or g.campeao_foto_url is not null)
       and g.created_at = p_cursor_em;
    select coalesce(array_agg(p.id), '{}'), coalesce(json_agg(json_build_object('id', p.id, 'team_id', p.team_id, 'author_id', p.author_id,
        'body', p.body, 'tipo', p.tipo, 'conteudo', p.conteudo, 'created_at', p.created_at)), '[]'::json)
      into v_ids_posts_inst, v_posts_inst
      from feed_posts p
     where p.team_id = any (v_times) and p.created_at = p_cursor_em;
    v_ids_jogos := v_ids_jogos || v_ids_jogos_inst;
    v_ids_posts := v_ids_posts || v_ids_posts_inst;
  end if;

  select json_build_object(
    'versao', 1,
    'vinculos', public.vinculos_da_pessoa_json(p_uid),
    'bloqueios', coalesce((select json_agg(json_build_object('blocker_id', b.blocker_id, 'blocked_id', b.blocked_id))
      from user_blocks b where b.blocker_id = p_uid or b.blocked_id = p_uid), '[]'::json),
    'jogos', v_jogos,
    'posts', v_posts,
    'jogos_no_instante', coalesce(v_jogos_inst, '[]'::json),
    'posts_no_instante', coalesce(v_posts_inst, '[]'::json),
    'media', coalesce((select json_agg(json_build_object('post_id', m.post_id, 'url', m.url, 'media_type', m.media_type, 'position', m.position)
      order by m.position asc) from feed_post_media m where m.post_id = any (v_ids_posts)), '[]'::json),
    'comentarios_jogos', coalesce((select json_agg(json_build_object('parent_id', c.parent_id, 'author_id', c.author_id, 'body', c.body,
      'created_at', c.created_at, 'users', (select json_build_object('id', u.id, 'nome', u.nome, 'nome_jogador', u.nome_jogador, 'avatar_url', u.avatar_url)
        from users u where u.id = c.author_id)) order by c.created_at desc)
      from comentarios c where c.parent_type = 'game' and c.parent_id = any (v_ids_jogos) and c.deleted_at is null), '[]'::json),
    'comentarios_posts', coalesce((select json_agg(json_build_object('parent_id', c.parent_id, 'author_id', c.author_id, 'body', c.body,
      'created_at', c.created_at, 'users', (select json_build_object('id', u.id, 'nome', u.nome, 'nome_jogador', u.nome_jogador, 'avatar_url', u.avatar_url)
        from users u where u.id = c.author_id)) order by c.created_at desc)
      from comentarios c where c.parent_type = 'post' and c.parent_id = any (v_ids_posts) and c.deleted_at is null), '[]'::json),
    'reacoes_jogos', coalesce((select json_agg(json_build_object('target_id', r.target_id, 'user_id', r.user_id, 'emoji', r.emoji))
      from reacoes r where r.target_type = 'game' and r.target_id = any (v_ids_jogos)), '[]'::json),
    'reacoes_posts', coalesce((select json_agg(json_build_object('target_id', r.target_id, 'user_id', r.user_id, 'emoji', r.emoji))
      from reacoes r where r.target_type = 'post' and r.target_id = any (v_ids_posts)), '[]'::json),
    -- As pessoas citadas pelos candidatos: os prêmios dos jogos, os autores dos posts e os jogadores do post do campeão.
    'usuarios', coalesce((select json_agg(json_build_object('id', u.id, 'nome', u.nome, 'nome_jogador', u.nome_jogador, 'email', u.email,
      'avatar_url', u.avatar_url))
      from users u
      where u.id in (
        select unnest(array[g.artilheiro_user_id, g.destaque_user_id, g.rodada_user_id]) from games g where g.id = any (v_ids_jogos)
        union select p.author_id from feed_posts p where p.id = any (v_ids_posts)
        union select (j ->> 'user_id')::uuid
                from feed_posts p, jsonb_array_elements(case when jsonb_typeof(p.conteudo -> 'campeao' -> 'jogadores') = 'array'
                                                             then p.conteudo -> 'campeao' -> 'jogadores' else '[]'::jsonb end) j
               where p.id = any (v_ids_posts) and p.conteudo ->> 'tipo' = 'campeao_campeonato'
                 and (j ->> 'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')), '[]'::json)
  ) into v_resultado;

  return v_resultado;
end
$fn$;

alter function public.feed_da_pessoa(uuid, uuid, integer, timestamptz, boolean) owner to postgres;
revoke all on function public.feed_da_pessoa(uuid, uuid, integer, timestamptz, boolean) from public;
revoke all on function public.feed_da_pessoa(uuid, uuid, integer, timestamptz, boolean) from anon, authenticated;
grant execute on function public.feed_da_pessoa(uuid, uuid, integer, timestamptz, boolean) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- O Ranking (/api/teams/:slug/ranking) numa ida só: o time pelo slug, o papel da pessoa nele e, do time, os membros (com a pessoa
-- embutida), os votos, os jogos, quem só organiza, os gols e as presenças confirmadas. O motor confere a suspensão do time, quem é membro
-- e quais jogos já aconteceram, e calcula o ranking como antes.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.ranking_do_time(p_uid uuid, p_slug text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_time uuid;
  v_resultado json;
begin
  select t.id into v_time from teams t where t.slug = p_slug;

  select json_build_object(
    'versao', 1,
    'time', (select json_build_object('id', t.id, 'slug', t.slug, 'nome', t.nome, 'cor', t.cor, 'fuso', t.fuso, 'escudo_cor2', t.escudo_cor2,
        'escudo_padrao', t.escudo_padrao, 'jogadores_por_time', t.jogadores_por_time, 'presenca_fundador_ate', t.presenca_fundador_ate)
      from teams t where t.id = v_time),
    'papel', (select tm.role from team_members tm where tm.team_id = v_time and tm.user_id = p_uid limit 1),
    'membros', coalesce((select json_agg(json_build_object('user_id', tm.user_id, 'categoria', tm.categoria, 'visivel_ranking', tm.visivel_ranking,
        'ativo', tm.ativo, 'users', (select json_build_object('id', u.id, 'nome', u.nome, 'nome_jogador', u.nome_jogador, 'email', u.email,
          'avatar_url', u.avatar_url, 'foto_url', u.foto_url, 'avatar_generico', u.avatar_generico, 'cor_frame', u.cor_frame)
          from users u where u.id = tm.user_id)))
      from team_members tm where tm.team_id = v_time), '[]'::json),
    'votos', coalesce((select json_agg(json_build_object('para_user_id', v.para_user_id, 'de_user_id', v.de_user_id, 'nota10', v.nota10))
      from votes v where v.team_id = v_time), '[]'::json),
    'jogos', coalesce((select json_agg(json_build_object('id', g.id, 'times_resultado', g.times_resultado, 'resultado_nivel', g.resultado_nivel,
        'campeao_time_index', g.campeao_time_index, 'time_vencedor', g.time_vencedor, 'artilheiro_user_id', g.artilheiro_user_id,
        'destaque_user_id', g.destaque_user_id, 'data', g.data, 'status', g.status, 'cancelado', g.cancelado))
      from games g where g.team_id = v_time), '[]'::json),
    'organizam', coalesce((select json_agg(tm.user_id) from team_members tm where tm.team_id = v_time and tm.joga = false), '[]'::json),
    'gols', coalesce((select json_agg(json_build_object('user_id', gj.user_id, 'gols', gj.gols))
      from gols_jogadores gj where gj.game_id in (select g.id from games g where g.team_id = v_time)), '[]'::json),
    -- As presenças confirmadas de TODOS os jogos do time: o motor fica com as dos jogos que já aconteceram.
    'presencas', coalesce((select json_agg(json_build_object('game_id', gp.game_id, 'user_id', gp.user_id))
      from game_players gp where gp.confirmado = true and gp.game_id in (select g.id from games g where g.team_id = v_time)), '[]'::json)
  ) into v_resultado;

  return v_resultado;
end
$fn$;

alter function public.ranking_do_time(uuid, text) owner to postgres;
revoke all on function public.ranking_do_time(uuid, text) from public;
revoke all on function public.ranking_do_time(uuid, text) from anon, authenticated;
grant execute on function public.ranking_do_time(uuid, text) to service_role;

-- O PostgREST passa a enxergar as funções novas sem esperar.
notify pgrst, 'reload schema';

-- =====================================================================
-- CONFERIR DEPOIS DE RODAR
-- select p.oid::regprocedure as funcao, p.prosecdef as definer, p.proconfig,
--        has_function_privilege('service_role', p.oid, 'execute') as service_role,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--        has_function_privilege('anon', p.oid, 'execute') as anon
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('inicio_da_pessoa', 'feed_da_pessoa', 'ranking_do_time', 'vinculos_da_pessoa_json');
-- → 4 linhas · definer true · {search_path=public} · service_role true · authenticated false · anon false
--
-- DESFAZER (o motor volta sozinho para o caminho antigo):
-- drop function if exists public.inicio_da_pessoa(uuid, timestamptz);
-- drop function if exists public.feed_da_pessoa(uuid, uuid, integer, timestamptz, boolean);
-- drop function if exists public.ranking_do_time(uuid, text);
-- drop function if exists public.vinculos_da_pessoa_json(uuid);
-- =====================================================================
