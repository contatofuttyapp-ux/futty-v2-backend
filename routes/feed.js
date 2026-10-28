// Futty v2.0 — Rotas da Resenha (feed social por time):
// feed unificado, posts editoriais e resultado do jogo. Upload, reações/comentários e denúncias vivem em
// sub-roteadores (uploadDaResenha, conversaDaResenha, denunciasDaResenha) montados aqui. asyncHandler + HttpError.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError, foraDoTime } = require('../utils/http');
const { supabase, getRole, getTeamBySlug, ensureUserRow, getUserById, loadGame } = require('../utils/db');
const { enviarNotificacao } = require('./push');
const { removerFicheirosPorUrl, urlGuardavelDeMidia } = require('../utils/storage');
const { urlDeMidiaValida, midiaEhDe } = require('../utils/validarUrl');
const { inteiroEmFaixa, ehUuid } = require('../utils/entrada');
const { conjuntoMutuo } = require('../utils/blocksStore');
const { marcarFase } = require('../middleware/tempo');
const { cotaBytesPorTime, bytesUsadosPeloTime, tamanhoNoStorage } = require('../utils/resenhaCota');
const { fusoDoTime, horaNoFuso, lerComFuso, temColuna } = require('../utils/fuso');
const { quantosTimes, escolhaDoCorpo, somaDeGols, decidirResultado, resultadoJaAbriu } = require('../utils/resultadoDoJogo'); // quem ganhou: uma verdade só
const { anunciarResultado } = require('../utils/avisoDoResultado');
const { STORAGE_BUCKET, reacoesParaTargets } = require('../utils/ajudaDaResenha');
const { obterVinculosDaPessoa } = require('../services/inicio'); // os times da pessoa, do mesmo cache do Início
const { criarIdaUnica } = require('../utils/idaUnica');

const router = express.Router();

// A Resenha numa ida só (utils/idaUnica.js, migração 090): a função do banco devolve as linhas das ~10 consultas da página. Sem ela
// (antes da migração, ou se falhar), o caminho antigo, igual a antes.
const idaDaResenha = criarIdaUnica('feed_da_pessoa', { cliente: supabase });

// Tipos de média aceites por contexto.
const POST_MEDIA = ['image', 'gif', 'video'];

// O feed tem limite: sem ele um time antigo puxaria todos os jogos e todos os posts desde sempre, em
// cada abertura da tela. 60 de cada lado dá mais de um mês de Resenha para um time que joga por
// semana. A paginação "ver mais antigos" está em PAGINA_FEED, abaixo.
const LIMITE_FEED = 60;
// O app novo pede o feed em PÁGINAS (`?limite=20`, e `?antes=<created_at do último>` para a seguinte).
// Sem `limite` a resposta é a de sempre (até 60 jogos + 60 posts de uma vez): os apps já publicados
// não conhecem `proximo` e ficariam sem como ver o resto.
const PAGINA_FEED = 20;
const PAGINA_FEED_MAX = 50;

// =====================================================================
// Helpers
// =====================================================================

/**
 * Para um conjunto de parents do mesmo tipo, devolve um mapa
 * parentId -> { recentes: [comentario...], total } com os 2 comentários mais
 * recentes de cada. UMA query por tipo (ordenada DESC), agrupada em memória — não N+1.
 * `linhas`: as que a ida única da Resenha já trouxe (de todos os candidatos, na mesma ordem; as de fora de `parentIds` não contam).
 */
async function comentariosRecentesParaTargets(parentType, parentIds, bloqueados, linhas = null) {
  const map = {};
  for (const id of parentIds) map[id] = { recentes: [], total: 0 };
  if (!parentIds.length) return map;

  // O autor vem EMBUTIDO: assim a query de `users` cobre só os jogos e os posts, que já se conhecem, e as
  // duas correm na mesma onda. Se os ids dos autores dos comentários só se soubessem depois desta query,
  // a de `users` teria de esperar por ela — uma ida em série a mais.
  const { data } = linhas ? { data: linhas } : await supabase
    .from('comentarios')
    .select('parent_id, author_id, body, created_at, users ( id, nome, nome_jogador, avatar_url )')
    .eq('parent_type', parentType)
    .in('parent_id', parentIds)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  for (const c of data || []) {
    // Bloqueio entre jogadores (Apple UGC 1.2): o comentário de quem está numa
    // relação de bloqueio com o pedinte simplesmente não existe para ele.
    if (bloqueados && bloqueados.has(c.author_id)) continue;
    const slot = map[c.parent_id];
    if (!slot) continue;
    slot.total += 1;
    if (slot.recentes.length < 2) slot.recentes.push(c);
  }
  return map;
}

// =====================================================================
// FEED
// =====================================================================

// ─── A ordem da Resenha e o cursor da página seguinte ─────────────────────────────────────────────────────────────────────
// A ordem é TOTAL: o instante de criação (mais novo primeiro), e no empate o tipo (jogo antes de post) e o id. Só o instante não
// bastava como cursor: linhas nascidas na mesma transação têm o MESMO created_at, e "antes do instante do último" pulava as que
// ficaram do outro lado da página. O cursor é "instante|tipo|id" do último item mandado; o antigo (só o instante, que um app já
// publicado pode ter guardado) continua valendo do jeito de antes.
const ORDEM_DO_TIPO = { jogo: 0, post: 1 };
const INSTANTE_DO_BANCO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** O instante em MICROssegundos (o Postgres guarda 6 casas; o Date do JS, 3): dois do mesmo milissegundo ainda se ordenam. */
function instante(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return -Infinity;
  const fracao = /\.(\d+)/.exec(String(iso))?.[1] || '';
  return ms * 1000 + Number(`${fracao}000000`.slice(3, 6));
}

/** Negativo = `a` vem antes (é mais novo). `a` e `b`: { tipo: 'jogo'|'post', r: { created_at, id } }. */
function compararItens(a, b) {
  const d = instante(b.r.created_at) - instante(a.r.created_at);
  if (d) return d;
  const t = ORDEM_DO_TIPO[a.tipo] - ORDEM_DO_TIPO[b.tipo];
  if (t) return t;
  const [x, y] = [String(a.r.id), String(b.r.id)];
  return x > y ? -1 : x < y ? 1 : 0;
}

const escreverCursor = (item) => `${item.r.created_at}|${item.tipo}|${item.r.id}`;

/** { em, tipo, id } do cursor novo; { em, tipo: null, id: null } do antigo; null se não for cursor nenhum. */
function lerCursor(bruto) {
  if (bruto == null || bruto === '') return null;
  const [em, tipo, id] = String(bruto).split('|');
  if (tipo != null) {
    if (INSTANTE_DO_BANCO.test(em) && ORDEM_DO_TIPO[tipo] != null && /^[\w-]{1,64}$/.test(id || '')) return { em, tipo, id };
    return null;
  }
  const ms = Date.parse(em);
  return Number.isNaN(ms) ? null : { em: new Date(ms).toISOString(), tipo: null, id: null };
}

// O post do campeão do campeonato (utils/postDoCampeao.js): linha de tipo 'post' com o retrato em `conteudo`.
const ehPostDoCampeao = (p) => p.conteudo?.tipo === 'campeao_campeonato';
const conteudoDoCampeaoComAvatares = (conteudo, avatarOf) => ({
  ...conteudo,
  campeao: { ...conteudo.campeao, jogadores: (conteudo.campeao?.jogadores || []).map((j) => ({ ...j, avatar_url: (j.user_id && avatarOf(j.user_id)) || j.avatar_url || null })) },
});

/**
 * GET /api/feed — feed unificado (jogos com campeão definido + posts),
 * ordenado por created_at DESC. Só de times onde o usuário é membro.
 * Query: team_id (opcional) filtra por uma equipa.
 */
router.get(
  '/api/feed',
  requireAuth,
  asyncHandler(async (req, res) => {
    marcarFase(res, 'auth');
    // Paginação (opt-in): cada lista pede UM a mais que a página, para saber se há mais; `antes` é o cursor (ver lerCursor).
    const paginado = req.query.limite != null;
    const limite = paginado ? Math.min(PAGINA_FEED_MAX, Math.max(1, parseInt(req.query.limite, 10) || PAGINA_FEED)) : LIMITE_FEED;
    const cursor = paginado ? lerCursor(req.query.antes) : null;
    const quantos = paginado ? limite + 1 : LIMITE_FEED;
    const filtro = req.query.team_id;

    // A ida única: os vínculos, os bloqueios, os candidatos da página e os detalhes de todos eles, de uma vez (fases `rpc` e
    // `montagem`). Sem ela (`lote` null), as consultas de sempre, em 3 ondas — o mesmo código monta a página nos dois casos.
    const lote = await idaDaResenha.chamar({
      p_uid: req.user.id, p_team: ehUuid(filtro) ? filtro : null, p_quantos: quantos, p_cursor_em: cursor?.em ?? null, p_no_instante: !!cursor?.tipo,
    });
    if (lote) marcarFase(res, 'rpc');

    // Times do usuário, do cache dos times da pessoa (o mesmo do Início: 60 s, esvaziado a cada escrita em times/vínculos —
    // utils/vinculosDaPessoa.js); o time vem com o fuso (o jogo da Resenha é lido no relógio do campo). Se o cache falhar, a leitura
    // própria de sempre.
    let memberships;
    if (lote) {
      memberships = lote.vinculos;
    } else {
      try {
        ({ vinculos: memberships } = await obterVinculosDaPessoa(req.user.id));
      } catch {
        ({ data: memberships } = await lerComFuso((novas) => supabase
          .from('team_members')
          .select(temColuna(novas, 'fuso') ? 'team_id, teams ( id, nome, slug, cidade, fuso )' : 'team_id, teams ( id, nome, slug, cidade )')
          .eq('user_id', req.user.id)));
      }
      marcarFase(res, 'equipas');
    }
    const teamMap = {};
    for (const m of memberships || []) {
      if (m.teams) teamMap[m.team_id] = m.teams;
    }

    let teamIds = Object.keys(teamMap);
    if (filtro) {
      if (!teamMap[filtro]) throw foraDoTime();
      teamIds = [filtro];
    }
    if (!teamIds.length) return res.json({ items: [] });

    // As idas ao banco saem em 3 ondas, não EM SÉRIE (sem a ida única).
    const jogosDaResenha = () => supabase
      .from('games')
      .select(
        'id, team_id, data, local, times_resultado, campeao_time_index, time_vencedor, placar_a, placar_b, campeao_foto_url, ' +
          'artilheiro_user_id, artilheiro_gols, destaque_user_id, destaque_titulo, ' +
          'rodada_user_id, rodada_foto_url, created_at'
      )
      .in('team_id', teamIds)
      // Entra na Resenha o jogo que tem resultado (campeão marcado OU empate explícito; `>= 0` é "não nulo" para o índice) e também o
      // jogo antigo que só tem a foto do campeão: o cartão mostra a foto sem dizer quem ganhou, e o ranking não ganha vitória nenhuma.
      .or('campeao_time_index.gte.0,time_vencedor.eq.empate,campeao_foto_url.not.is.null');
    const postsDaResenha = () => supabase
      .from('feed_posts')
      .select('id, team_id, author_id, body, tipo, conteudo, created_at')
      .in('team_id', teamIds);
    // A ordem é a mesma de compararItens (instante, e no empate o id), para o "um a mais" de cada lista cortar no lugar certo.
    const emOrdem = (q) => q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(quantos);
    // Com a ida única nada disto é montado (as linhas já vieram).
    let consultaJogos = lote ? null : emOrdem(jogosDaResenha());
    let consultaPosts = lote ? null : emOrdem(postsDaResenha());
    // Os itens do MESMO instante do cursor (só quando o cursor diz qual foi o último): lidos à parte, na mesma onda, e deles fica o
    // que vem depois do cursor na ordem. Quase sempre volta vazio.
    let noInstanteJogos = Promise.resolve({ data: [] });
    let noInstantePosts = Promise.resolve({ data: [] });
    if (cursor && !lote) {
      consultaJogos = consultaJogos.lt('created_at', cursor.em);
      consultaPosts = consultaPosts.lt('created_at', cursor.em);
      if (cursor.tipo) {
        noInstanteJogos = jogosDaResenha().eq('created_at', cursor.em);
        noInstantePosts = postsDaResenha().eq('created_at', cursor.em);
      }
    }

    // Onda 2: o bloqueio, os jogos e os posts não dependem uns dos outros — só
    // de teamIds. (A filtragem por bloqueio é feita em memória logo a seguir.)
    const [bloqueados, jogosRes, postsRes, empJogos, empPosts] = await Promise.all([
      // Bloqueio entre jogadores (Apple UGC 1.2): quem bloqueou/foi bloqueado por
      // este usuário não aparece na Resenha dele — nem posts nem comentários.
      conjuntoMutuo(req.user.id, lote ? lote.bloqueios : null),
      lote ? { data: lote.jogos } : consultaJogos,
      lote ? { data: lote.posts } : consultaPosts,
      lote ? { data: lote.jogos_no_instante } : noInstanteJogos,
      lote ? { data: lote.posts_no_instante } : noInstantePosts,
    ]);
    if (!lote) marcarFase(res, 'jogos+posts');
    if (jogosRes.error) throw new HttpError(500, jogosRes.error.message);
    if (postsRes.error) throw new HttpError(500, postsRes.error.message);
    const depoisDoCursor = (tipo) => (r) => !cursor?.tipo || compararItens({ tipo, r }, { tipo: cursor.tipo, r: { created_at: cursor.em, id: cursor.id } }) > 0;
    let games = [...(empJogos.data || []).filter(depoisDoCursor('jogo')), ...(jogosRes.data || [])];
    let posts = [...(empPosts.data || []).filter(depoisDoCursor('post')), ...(postsRes.data || [])].filter((p) => !bloqueados.has(p.author_id));

    // Página (só no modo paginado): os `limite` mais recentes dos dois tipos JUNTOS. Cada lista trouxe até limite+1, então o
    // top-`limite` da mistura está inteiro dentro delas. Daqui para baixo (comentários, reações, mídias) só trabalha a página —
    // é onde o feed pesava. `proximo` é o cursor da página seguinte (null = acabou).
    let proximo = null;
    if (paginado) {
      const todos = [...games.map((r) => ({ tipo: 'jogo', r })), ...posts.map((r) => ({ tipo: 'post', r }))].sort(compararItens);
      const pagina = todos.slice(0, limite);
      const temMais = todos.length > limite || (jogosRes.data || []).length > limite || (postsRes.data || []).length > limite;
      if (temMais && pagina.length) proximo = escreverCursor(pagina[pagina.length - 1]);
      games = pagina.filter((x) => x.tipo === 'jogo').map((x) => x.r);
      posts = pagina.filter((x) => x.tipo === 'post').map((x) => x.r);
    }

    const gameIds = games.map((g) => g.id);
    const postIds = posts.map((p) => p.id);

    // Os usuários referenciados pelos JOGOS e pelos POSTS já se conhecem
    // aqui (prémios e autores), por isso a query deles entra na onda 3 em vez
    // de esperar por ela. Os autores dos COMENTÁRIOS vêm embutidos na própria
    // query dos comentários.
    const idsConhecidos = new Set();
    for (const g of games) {
      for (const id of [g.artilheiro_user_id, g.destaque_user_id, g.rodada_user_id]) if (id) idsConhecidos.add(id);
    }
    for (const p of posts) if (p.author_id) idsConhecidos.add(p.author_id);
    // O post do campeão do campeonato traz os jogadores do time campeão: o avatar de cada um vem do cadastro de hoje, não da foto
    // de quando o campeonato foi criado.
    for (const p of posts) for (const j of ehPostDoCampeao(p) ? p.conteudo.campeao?.jogadores || [] : []) if (j.user_id) idsConhecidos.add(j.user_id);

    // Onda 3: tudo o que depende dos ids acima, de uma vez só — média, os 2
    // comentários recentes de cada lado, as reações de cada lado e os users.
    // Com a ida única, os detalhes vieram de TODOS os candidatos: só os da página são lidos abaixo (os mapas são por id).
    const [mediaRes, comGames, comPosts, reacGames, reacPosts, usersRes] = await Promise.all([
      lote ? { data: lote.media } : postIds.length
        ? supabase.from('feed_post_media').select('post_id, url, media_type, position').in('post_id', postIds).order('position', { ascending: true })
        : Promise.resolve({ data: [] }),
      comentariosRecentesParaTargets('game', gameIds, bloqueados, lote ? lote.comentarios_jogos : null),
      comentariosRecentesParaTargets('post', postIds, bloqueados, lote ? lote.comentarios_posts : null),
      reacoesParaTargets('game', gameIds, req.user.id, lote ? lote.reacoes_jogos : null),
      reacoesParaTargets('post', postIds, req.user.id, lote ? lote.reacoes_posts : null),
      lote ? { data: lote.usuarios } : idsConhecidos.size
        ? supabase.from('users').select('id, nome, nome_jogador, email, avatar_url').in('id', [...idsConhecidos])
        : Promise.resolve({ data: [] }),
    ]);

    marcarFase(res, lote ? 'montagem' : 'detalhes');

    const mediaByPost = {};
    for (const m of mediaRes.data || []) {
      (mediaByPost[m.post_id] ||= []).push({ url: m.url, media_type: m.media_type, position: m.position });
    }

    // Os autores dos comentários vieram embutidos; os prémios/autores de posts
    // vieram da query de users da onda 3. Juntam-se no mesmo mapa.
    const userMap = {};
    for (const slot of [...Object.values(comGames), ...Object.values(comPosts)]) {
      for (const c of slot.recentes) if (c.users) userMap[c.users.id] = c.users;
    }
    for (const u of usersRes.data || []) userMap[u.id] = u;

    const nomeOf = (id) => {
      const u = userMap[id];
      return u ? u.nome_jogador || u.nome || 'Jogador' : null;
    };
    const avatarOf = (id) => userMap[id]?.avatar_url || null;
    const comentariosDe = (slot) => ({
      comentarios_total: slot?.total || 0,
      comentarios_recentes: (slot?.recentes || []).map((c) => ({
        nome: nomeOf(c.author_id),
        avatar_url: avatarOf(c.author_id),
        body: c.body,
      })),
    });

    const jogoItems = (games || []).map((g) => {
      const team = teamMap[g.team_id] || {};
      const fuso = fusoDoTime(team);
      return {
        kind: 'jogo',
        id: g.id,
        created_at: g.created_at,
        date: g.data,
        time: g.data ? horaNoFuso(g.data, fuso) : null, // HH:MM no relógio do campo (era UTC)
        fuso, // a data e a hora do jogo se leem neste fuso
        location: g.local,
        team_id: g.team_id,
        team_name: team.nome || null,
        team_slug: team.slug || null,
        times_resultado: g.times_resultado,
        campeao_time_index: g.campeao_time_index,
        // Empate: sem campeão, `time_vencedor` = 'empate' e o placar (se houve) para o post dizer "Ouro 2 × 2 Roxo".
        time_vencedor: g.time_vencedor ?? null,
        placar_a: g.placar_a ?? null,
        placar_b: g.placar_b ?? null,
        campeao_foto_url: g.campeao_foto_url,
        artilheiro_user_id: g.artilheiro_user_id,
        artilheiro_gols: g.artilheiro_gols,
        artilheiro_nome: g.artilheiro_user_id ? nomeOf(g.artilheiro_user_id) : null,
        artilheiro_avatar_url: g.artilheiro_user_id ? avatarOf(g.artilheiro_user_id) : null,
        destaque_user_id: g.destaque_user_id,
        destaque_titulo: g.destaque_titulo,
        destaque_nome: g.destaque_user_id ? nomeOf(g.destaque_user_id) : null,
        destaque_avatar_url: g.destaque_user_id ? avatarOf(g.destaque_user_id) : null,
        rodada_user_id: g.rodada_user_id,
        rodada_foto_url: g.rodada_foto_url,
        rodada_nome: g.rodada_user_id ? nomeOf(g.rodada_user_id) : null,
        rodada_avatar_url: g.rodada_user_id ? avatarOf(g.rodada_user_id) : null,
        contagem_reacoes: reacGames[g.id]?.contagem || {},
        minha_reacao: reacGames[g.id]?.minha || null,
        ...comentariosDe(comGames[g.id]),
      };
    });

    const postItems = (posts || []).map((p) => {
      const team = teamMap[p.team_id] || {};
      return {
        kind: 'post',
        id: p.id,
        created_at: p.created_at,
        team_id: p.team_id,
        team_name: team.nome || null,
        fuso: fusoDoTime(team),
        author_id: p.author_id,
        author_nome: nomeOf(p.author_id),
        author_avatar_url: avatarOf(p.author_id),
        body: p.body,
        tipo: p.tipo || 'post',
        conteudo: ehPostDoCampeao(p) ? conteudoDoCampeaoComAvatares(p.conteudo, avatarOf) : p.conteudo || null,
        media: mediaByPost[p.id] || [],
        contagem_reacoes: reacPosts[p.id]?.contagem || {},
        minha_reacao: reacPosts[p.id]?.minha || null,
        ...comentariosDe(comPosts[p.id]),
      };
    });

    // Mistura jogos + posts na ordem da Resenha (compararItens: a mesma do cursor).
    const items = [...jogoItems, ...postItems].sort((a, b) => compararItens({ tipo: a.kind, r: a }, { tipo: b.kind, r: b }));
    res.json(paginado ? { items, proximo } : { items });
  })
);
// A prova de equivalência (a bancada de Postgres da rodada) liga e desliga a função entre um pedido e outro.
router.idaDaResenha = idaDaResenha;

// =====================================================================
// POSTS EDITORIAIS
// =====================================================================

/** POST /api/feed/posts — cria um post (admin ou membro com pode_postar). */
router.post(
  '/api/feed/posts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team_id: teamId, body, media } = req.body || {};
    if (!teamId) throw new HttpError(400, 'team_id é obrigatório.');
    if (!ehUuid(teamId)) throw new HttpError(400, 'team_id inválido.');
    if (body != null && typeof body !== 'string') throw new HttpError(400, 'O texto do post precisa ser texto.');
    const texto = String(body ?? '').trim();
    const mediaList = (Array.isArray(media) ? media : []).filter((m) => m && m.url);
    // Texto é opcional QUANDO há média; vazio total é rejeitado.
    if (!texto && mediaList.length === 0) throw new HttpError(400, 'O post precisa de texto ou média.');
    if (texto.length > 2000) throw new HttpError(400, 'Máximo 2000 caracteres.');
    if (mediaList.length > 4) throw new HttpError(400, 'Máximo 4 anexos por post.');

    // Permissão: admin OU pode_postar
    const { data: membership } = await supabase
      .from('team_members')
      .select('role, pode_postar')
      .eq('team_id', teamId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!membership) throw foraDoTime();
    if (membership.role !== 'admin' && !membership.pode_postar) {
      throw new HttpError(403, 'Você não tem permissão para publicar neste time.');
    }

    // SEGURANCA-REVISAO-10SET.md secção 3: só aceita URLs https do
    // Storage do Supabase ou do proxy do próprio backend (/api/media/) —
    // impede que o campo vire um redirect/SSRF para qualquer host. E só mídia que a própria pessoa subiu (o nome do arquivo leva o
    // id de quem subiu): anexar a foto de outra pessoa e depois apagar o post apagava a foto dela do Storage.
    if (mediaList.some((m) => !midiaEhDe(m.url, req, req.user.id))) {
      throw new HttpError(400, 'URL de mídia inválida.');
    }

    // Cota de 500 MB por time (Rodada 15) — checada ANTES de criar o post,
    // para não sobrar um post vazio se a mídia estourar o limite. O tamanho
    // de cada anexo vem do STORAGE de verdade (tamanhoNoStorage), nunca do
    // que o body diz — evita fingir um arquivo pequeno pra furar a cota.
    //
    // Sem a migração 053, bytesUsadosPeloTime devolve null: a cota não
    // bloqueia (fail-open, aviso já registrado por ela) E `colunaBytes` fica
    // false, pra também NÃO tentar gravar feed_post_media.bytes — a coluna
    // simplesmente não existe ainda, e um INSERT com uma coluna inexistente
    // falharia com 500 em TODO post com mídia, não só na cota. O mesmo sinal
    // (a RPC respondeu) decide os dois.
    const bytesPorUrl = new Map();
    let colunaBytes = false;
    if (mediaList.length) {
      const tamanhos = await Promise.all(mediaList.map((m) => tamanhoNoStorage(m.url)));
      mediaList.forEach((m, i) => bytesPorUrl.set(m.url, tamanhos[i]));
      const novosBytes = tamanhos.reduce((soma, b) => soma + (b || 0), 0);
      const usados = await bytesUsadosPeloTime(teamId);
      colunaBytes = usados !== null;
      if (usados != null && usados + novosBytes > cotaBytesPorTime()) {
        throw new HttpError(413, 'A Resenha deste time chegou ao limite de fotos. Apague posts antigos para liberar espaço.');
      }
    }

    await ensureUserRow(req.user);

    const { data: post, error } = await supabase
      .from('feed_posts')
      .insert({ team_id: teamId, author_id: req.user.id, body: texto })
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Anexos do post (máx 4 — validado acima; slice como defesa).
    const mediaRows = mediaList
      .slice(0, 4)
      .map((m, i) => {
        const linha = {
          post_id: post.id,
          // Guarda bucket + caminho (a forma crua do Storage), nunca o token do proxy, que vence: a leitura assina de novo.
          url: urlGuardavelDeMidia(String(m.url)),
          media_type: POST_MEDIA.includes(m.media_type) ? m.media_type : 'image',
          position: Number.isFinite(Number(m.position)) ? Number(m.position) : i,
        };
        if (colunaBytes) linha.bytes = bytesPorUrl.get(m.url) ?? null;
        return linha;
      });
    let savedMedia = [];
    if (mediaRows.length) {
      const { data: mm, error: me } = await supabase
        .from('feed_post_media')
        .insert(mediaRows)
        .select('url, media_type, position');
      if (me) throw new HttpError(500, me.message);
      savedMedia = mm || [];
    }

    const author = await getUserById(req.user.id);
    res.status(201).json({
      post: {
        kind: 'post',
        id: post.id,
        team_id: post.team_id,
        author_id: post.author_id,
        author_nome: author?.nome_jogador || author?.nome || 'Jogador',
        author_avatar_url: author?.avatar_url || null,
        body: post.body,
        media: savedMedia,
        created_at: post.created_at,
        contagem_reacoes: {},
        minha_reacao: null,
      },
    });
  })
);

/** POST /api/feed/equipas/:slug/anuncio — anúncio oficial no feed (só admin). */
router.post(
  '/api/feed/equipas/:slug/anuncio',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem publicar anúncios.');

    const titulo = String(req.body?.titulo || '').trim();
    const mensagem = String(req.body?.mensagem || '').trim();
    if (!titulo || !mensagem) throw new HttpError(400, 'Título e mensagem são obrigatórios.');
    if (titulo.length > 80) throw new HttpError(400, 'Título: máximo 80 caracteres.');

    const msg = mensagem.slice(0, 500);
    const { data: post, error } = await supabase
      .from('feed_posts')
      .insert({ team_id: team.id, author_id: req.user.id, tipo: 'anuncio', body: msg, conteudo: { titulo, mensagem: msg } })
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    const author = await getUserById(req.user.id);
    res.status(201).json({
      post: {
        kind: 'post',
        id: post.id,
        team_id: post.team_id,
        author_id: post.author_id,
        author_nome: author?.nome_jogador || author?.nome || 'Jogador',
        author_avatar_url: author?.avatar_url || null,
        body: post.body,
        tipo: 'anuncio',
        conteudo: post.conteudo,
        media: [],
        created_at: post.created_at,
        contagem_reacoes: {},
        minha_reacao: null,
      },
    });
  })
);

/** DELETE /api/feed/posts/:postId — apaga (autor ou admin do time). */
router.delete(
  '/api/feed/posts/:postId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: post } = await supabase
      .from('feed_posts')
      .select('id, team_id, author_id')
      .eq('id', req.params.postId)
      .maybeSingle();
    if (!post) throw new HttpError(404, 'Post não encontrado.');

    const role = await getRole(post.team_id, req.user.id);
    if (!role) throw foraDoTime();
    if (post.author_id !== req.user.id && role !== 'admin') {
      throw new HttpError(403, 'Só o autor ou um admin pode excluir.');
    }

    // Antes do cascade na BD, junta as URLs da média para apagar os OBJETOS no Storage —
    // senão ficam órfãos, públicos e para sempre.
    const { data: media } = await supabase
      .from('feed_post_media')
      .select('url')
      .eq('post_id', post.id);

    // feed_post_media tem ON DELETE CASCADE (apaga as linhas)
    const { error } = await supabase.from('feed_posts').delete().eq('id', post.id);
    if (error) throw new HttpError(500, error.message);

    // Best-effort: mata os arquivos no bucket. Se falhar, registra e segue — o
    // usuário já viu o post desaparecer; não quebramos o fluxo por um órfão.
    const urls = (media || []).map((m) => m.url);
    if (urls.length) {
      const r = await removerFicheirosPorUrl(STORAGE_BUCKET, urls);
      console.log('[feed] post apagado, ficheiros no Storage:', { post: post.id, ...r });
    }

    res.json({ deleted: true });
  })
);

// =====================================================================
// RESULTADO DO JOGO
// =====================================================================

/**
 * PATCH /api/feed/games/:gameId/resultado — define campeão/artilheiro/
 * destaque/rodada de cerveja (só admin do time). Semântica PATCH:
 * só os campos enviados são atualizados.
 * Nota: o schema só tem role admin/member; não existe "moderador com
 * permissão jogos", por isso restringe-se a admin.
 */
router.patch(
  '/api/feed/games/:gameId/resultado',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.gameId);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar o resultado.');
    // A mesma trava do PATCH /api/games/:id/resultado: o resultado (e os prêmios do dia) abrem 5 minutos depois do início; jogo histórico não tem.
    if (!resultadoJaAbriu(game)) throw new HttpError(400, 'O resultado abre 5 minutos depois do início do jogo.');

    const b = req.body || {};
    const patch = {};

    if ('campeao_time_index' in b || b.empate === true) {
      // Quem ganhou passa pela MESMA regra do PATCH /api/games/:id/resultado: o campeão é a verdade e o `time_vencedor` sai dele.
      // Placar e vencedor nunca são escolhas separadas: se o jogo tem gols lançados, eles decidem (a soma por time é o placar) e o que foi
      // tocado aqui não vale; sem gols, o campeão tocado vale e o placar digitado de antes se desfaz.
      const escolha = escolhaDoCorpo(b);
      const { data: golsRows } = await supabase.from('gols_jogadores').select('time, gols').eq('game_id', game.id);
      const { porTime, temGols } = somaDeGols(golsRows || []);
      const decisao = decidirResultado({ nTimes: quantosTimes(game.times_resultado), campeaoIdx: escolha.campeaoIdx, empate: escolha.empate, golsPorTime: porTime, temGols });
      Object.assign(patch, decisao);
    }
    if ('campeao_foto_url' in b) {
      if (b.campeao_foto_url && !urlDeMidiaValida(b.campeao_foto_url, req)) {
        throw new HttpError(400, 'URL de mídia inválida.');
      }
      patch.campeao_foto_url = urlGuardavelDeMidia(b.campeao_foto_url) || null;
    }
    // Os prêmios do dia são de gente do time: um id de fora ia virar, na resposta, o nome de uma pessoa de outro time.
    // (O que já estava gravado continua valendo: quem saiu do time depois do jogo não trava a edição do resultado.)
    const premiado = async (valor, atual) => {
      if (!valor) return null;
      if (valor === atual) return valor;
      if (!ehUuid(valor)) throw new HttpError(400, 'Esse jogador não é do time.');
      if (!(await getRole(game.teams.id, valor))) throw new HttpError(400, 'Esse jogador não é do time.');
      return valor;
    };
    if ('artilheiro_user_id' in b) patch.artilheiro_user_id = await premiado(b.artilheiro_user_id, game.artilheiro_user_id);
    if ('artilheiro_gols' in b) {
      if (b.artilheiro_gols === null || b.artilheiro_gols === '') patch.artilheiro_gols = null;
      else patch.artilheiro_gols = inteiroEmFaixa(b.artilheiro_gols, { min: 0, max: 99, rotulo: 'artilheiro_gols' });
    }
    if ('destaque_user_id' in b) patch.destaque_user_id = await premiado(b.destaque_user_id, game.destaque_user_id);
    if ('destaque_titulo' in b) {
      const titulo = b.destaque_titulo == null ? null : String(b.destaque_titulo).trim();
      if (titulo && titulo.length > 60) throw new HttpError(400, 'destaque_titulo: máximo 60 caracteres.');
      patch.destaque_titulo = titulo || null;
    }
    if ('rodada_user_id' in b) patch.rodada_user_id = await premiado(b.rodada_user_id, game.rodada_user_id);
    if ('rodada_foto_url' in b) {
      if (b.rodada_foto_url && !urlDeMidiaValida(b.rodada_foto_url, req)) {
        throw new HttpError(400, 'URL de mídia inválida.');
      }
      patch.rodada_foto_url = urlGuardavelDeMidia(b.rodada_foto_url) || null;
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase
      .from('games')
      .update(patch)
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Resolve os nomes dos jogadores premiados (join com users).
    const premioIds = [updated.artilheiro_user_id, updated.destaque_user_id, updated.rodada_user_id].filter(Boolean);
    const nomes = {};
    if (premioIds.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador, email').in('id', premioIds);
      for (const u of us || []) nomes[u.id] = u.nome_jogador || u.nome || 'Jogador';
    }
    res.json({
      game: {
        ...updated,
        fuso: fusoDoTime(game.teams),
        artilheiro_nome: updated.artilheiro_user_id ? nomes[updated.artilheiro_user_id] || null : null,
        destaque_nome: updated.destaque_user_id ? nomes[updated.destaque_user_id] || null : null,
        rodada_nome: updated.rodada_user_id ? nomes[updated.rodada_user_id] || null : null,
      },
    });

    // Avisa o time (fire-and-forget) — só quando o jogo ganha o primeiro resultado ou prêmio; corrigir o que já foi anunciado não avisa de novo.
    anunciarResultado({
      antes: game,
      depois: updated,
      local: game.local,
      membros: async () => {
        const { data } = await supabase.from('team_members').select('user_id').eq('team_id', game.teams.id);
        return (data || []).map((m) => m.user_id);
      },
      enviar: enviarNotificacao,
    });
  })
);

// O envio de foto, GIF e vídeo (routes/uploadDaResenha.js).
router.use(require('./uploadDaResenha'));

// Reações e comentários (routes/conversaDaResenha.js).
router.use(require('./conversaDaResenha'));

// Denúncias da Resenha (routes/denunciasDaResenha.js).
router.use(require('./denunciasDaResenha'));

module.exports = router;
