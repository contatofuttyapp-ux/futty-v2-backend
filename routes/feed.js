// Futty v2.0 — Rotas da Resenha (feed social por equipa):
// feed unificado, posts editoriais, resultado do jogo, upload, reações,
// comentários e denúncias. Segue os padrões do repo: asyncHandler + HttpError.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { requireAuth } = require('../middleware/auth');
const { denunciaLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, getTeamBySlug, ensureUserRow, getUserById, loadGame } = require('../utils/db');
const { enviarNotificacao } = require('./push');
const { filtroNSFW } = require('../utils/nsfwFilter');
const { removerFicheirosPorUrl } = require('../utils/storage');
const { urlDeMidiaValida } = require('../utils/validarUrl');
const { conjuntoMutuo } = require('../utils/blocksStore');
const { marcarFase } = require('../middleware/tempo');

const router = express.Router();

// Os 7 emojis permitidos (igual ao CHECK — ver migração 036 que adiciona 🍿).
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡', '🍿'];
// Tipos de média aceites por contexto.
const POST_MEDIA = ['image', 'gif', 'video'];
const COMENTARIO_MEDIA = ['image', 'gif'];
// Motivos de denúncia (igual ao CHECK da migração 009).
const DENUNCIA_MOTIVOS = ['linguagem_inapropriada', 'spam', 'conteudo_ofensivo', 'outro'];

// VELOCIDADE 6A (15-set): o feed vinha SEM limite — uma equipa antiga puxava
// todos os jogos e todos os posts desde sempre, em cada abertura da tela. 60 de
// cada lado dá mais de um mês de Resenha para uma equipa que joga por semana.
// A paginação "ver mais antigos" fica para a v1.1 (registado em ONDE-ESTAMOS.md).
const LIMITE_FEED = 60;

// Upload: lê o ficheiro para memória; envia-se depois ao Supabase Storage.
//
// RODADA 15 (16-set): o teto geral desceu de 50MB para 12MB — fotos JPG/PNG/
// WebP passam por compressão (ver comprimirImagem) antes de gravar, então
// chegam bem abaixo disto; GIF tem o seu PRÓPRIO teto, mais apertado
// (GIF_MAX_BYTES), porque não é comprimido (perderia a animação). Vídeo
// segue sem transcodificação — 12MB é o teto dele também agora (era 50MB).
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
const GIF_MAX_BYTES = 8 * 1024 * 1024;
// Lado maior de uma foto comprimida (px) e qualidade do WebP de saída.
const COMPRESSAO_LADO_MAX = 1600;
const COMPRESSAO_QUALIDADE = 80;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });
// Wrapper que traduz o erro de tamanho do multer numa mensagem clara.
function receberFicheiro(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, `Arquivo grande demais: o limite é ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB. Fotos são otimizadas automaticamente; GIFs até ${GIF_MAX_BYTES / (1024 * 1024)}MB.`));
      }
      return next(new HttpError(400, 'Falha ao receber o arquivo.'));
    }
    next();
  });
}
// mimetype -> extensão (lista branca de tipos aceites no upload).
const UPLOAD_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};
// Fotos estáticas que passam por compressão (o GIF fica de fora: animado).
const IMAGENS_COMPRIMIVEIS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const STORAGE_BUCKET = 'resenha';
// Regex de menção: @<uuid> dentro do corpo do comentário.
const MENTION_RE = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// =====================================================================
// Helpers
// =====================================================================

/** Devolve o team_id do parent ('game' | 'post') ou null se não existir. */
async function parentTeamId(parentType, parentId) {
  if (parentType === 'game') {
    const { data } = await supabase.from('games').select('team_id').eq('id', parentId).maybeSingle();
    return data?.team_id || null;
  }
  if (parentType === 'post') {
    const { data } = await supabase.from('feed_posts').select('team_id').eq('id', parentId).maybeSingle();
    return data?.team_id || null;
  }
  return null;
}

/**
 * Devolve o team_id de um target de reação/denúncia.
 * Para 'comentario' resolve o parent do comentário; 'game'/'post' são diretos.
 */
async function targetTeamId(targetType, targetId) {
  if (targetType === 'comentario') {
    const { data } = await supabase
      .from('comentarios')
      .select('parent_type, parent_id')
      .eq('id', targetId)
      .maybeSingle();
    if (!data) return null;
    return parentTeamId(data.parent_type, data.parent_id);
  }
  return parentTeamId(targetType, targetId);
}

/**
 * Para um conjunto de targets do mesmo tipo, devolve um mapa
 * id -> { contagem: { emoji: N }, minha: emoji|null } com a reação do user.
 */
async function reacoesParaTargets(targetType, targetIds, userId) {
  const map = {};
  for (const id of targetIds) map[id] = { contagem: {}, minha: null };
  if (!targetIds.length) return map;

  const { data } = await supabase
    .from('reacoes')
    .select('target_id, user_id, emoji')
    .eq('target_type', targetType)
    .in('target_id', targetIds);

  for (const r of data || []) {
    const slot = map[r.target_id];
    if (!slot) continue;
    slot.contagem[r.emoji] = (slot.contagem[r.emoji] || 0) + 1;
    if (r.user_id === userId) slot.minha = r.emoji;
  }
  return map;
}

/**
 * Para um conjunto de parents do mesmo tipo, devolve um mapa
 * parentId -> { recentes: [comentario...], total } com os 2 comentários mais
 * recentes de cada. UMA query por tipo (ordenada DESC), agrupada em memória — não N+1.
 */
async function comentariosRecentesParaTargets(parentType, parentIds, bloqueados) {
  const map = {};
  for (const id of parentIds) map[id] = { recentes: [], total: 0 };
  if (!parentIds.length) return map;

  // VELOCIDADE 6A (15-set): o autor vem EMBUTIDO. Antes, os ids dos autores dos
  // comentários só se sabiam depois desta query, o que obrigava a query de
  // `users` a esperar por ela — uma ida em série a mais. Com o autor embutido,
  // a query de users cobre só os jogos e os posts, que já se conhecem, e as
  // duas correm na mesma onda.
  const { data } = await supabase
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

/**
 * Comprime uma foto estática antes de gravar (Rodada 15): respeita a
 * orientação EXIF, reduz o lado maior a COMPRESSAO_LADO_MAX (nunca amplia) e
 * converte para WebP. Fail-open: se o sharp falhar (arquivo corrompido de um
 * jeito que passou pelo NSFW mas não pelo decode aqui), grava o ORIGINAL em
 * vez de derrubar o upload — melhor uma foto grande que nenhuma foto.
 * Devolve { buffer, mimetype, ext }.
 */
async function comprimirImagem(buffer, mimetypeOriginal, extOriginal) {
  try {
    const comprimido = await sharp(buffer)
      .rotate() // aplica a orientação EXIF antes de qualquer coisa — sem isto a rotação vai junto para o WebP
      .resize(COMPRESSAO_LADO_MAX, COMPRESSAO_LADO_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: COMPRESSAO_QUALIDADE })
      .toBuffer();
    return { buffer: comprimido, mimetype: 'image/webp', ext: 'webp' };
  } catch (e) {
    console.error('[feed] compressão falhou, gravando o arquivo original:', e.message);
    return { buffer, mimetype: mimetypeOriginal, ext: extOriginal };
  }
}

/** Garante (uma vez por processo) que o bucket público da Resenha existe. */
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  // Ignora erro caso o bucket já exista (idempotente).
  await supabase.storage.createBucket(STORAGE_BUCKET, { public: true }).catch(() => {});
  bucketReady = true;
}

// =====================================================================
// FEED
// =====================================================================

/**
 * GET /api/feed — feed unificado (jogos com campeão definido + posts),
 * ordenado por created_at DESC. Só de equipas onde o utilizador é membro.
 * Query: team_id (opcional) filtra por uma equipa.
 */
router.get(
  '/api/feed',
  requireAuth,
  asyncHandler(async (req, res) => {
    marcarFase(res, 'auth');
    // Equipas do utilizador
    const { data: memberships } = await supabase
      .from('team_members')
      .select('team_id, teams ( id, nome, slug )')
      .eq('user_id', req.user.id);
    marcarFase(res, 'equipas');
    const teamMap = {};
    for (const m of memberships || []) {
      if (m.teams) teamMap[m.team_id] = m.teams;
    }

    let teamIds = Object.keys(teamMap);
    const filtro = req.query.team_id;
    if (filtro) {
      if (!teamMap[filtro]) throw new HttpError(403, 'Você não é membro deste time.');
      teamIds = [filtro];
    }
    if (!teamIds.length) return res.json({ items: [] });

    // VELOCIDADE 6A (15-set): eram 10 idas ao banco EM SÉRIE. Agora são 3 ondas.
    //
    // Onda 2: o bloqueio, os jogos e os posts não dependem uns dos outros — só
    // de teamIds. (A filtragem por bloqueio é feita em memória logo a seguir.)
    const [bloqueados, jogosRes, postsRes] = await Promise.all([
      // Bloqueio entre jogadores (Apple UGC 1.2): quem bloqueou/foi bloqueado por
      // este utilizador não aparece na Resenha dele — nem posts nem comentários.
      conjuntoMutuo(req.user.id),
      supabase
        .from('games')
        .select(
          'id, team_id, data, local, times_resultado, campeao_time_index, campeao_foto_url, ' +
            'artilheiro_user_id, artilheiro_gols, destaque_user_id, destaque_titulo, ' +
            'rodada_user_id, rodada_foto_url, created_at'
        )
        .in('team_id', teamIds)
        .not('campeao_time_index', 'is', null)
        .order('created_at', { ascending: false })
        .limit(LIMITE_FEED),
      supabase
        .from('feed_posts')
        .select('id, team_id, author_id, body, tipo, conteudo, created_at')
        .in('team_id', teamIds)
        .order('created_at', { ascending: false })
        .limit(LIMITE_FEED),
    ]);
    marcarFase(res, 'jogos+posts');
    if (jogosRes.error) throw new HttpError(500, jogosRes.error.message);
    if (postsRes.error) throw new HttpError(500, postsRes.error.message);
    const games = jogosRes.data || [];
    const posts = (postsRes.data || []).filter((p) => !bloqueados.has(p.author_id));

    const gameIds = games.map((g) => g.id);
    const postIds = posts.map((p) => p.id);

    // Os utilizadores referenciados pelos JOGOS e pelos POSTS já se conhecem
    // aqui (prémios e autores), por isso a query deles entra na onda 3 em vez
    // de esperar por ela. Os autores dos COMENTÁRIOS vêm embutidos na própria
    // query dos comentários.
    const idsConhecidos = new Set();
    for (const g of games) {
      for (const id of [g.artilheiro_user_id, g.destaque_user_id, g.rodada_user_id]) if (id) idsConhecidos.add(id);
    }
    for (const p of posts) if (p.author_id) idsConhecidos.add(p.author_id);

    // Onda 3: tudo o que depende dos ids acima, de uma vez só — média, os 2
    // comentários recentes de cada lado, as reações de cada lado e os users.
    const [mediaRes, comGames, comPosts, reacGames, reacPosts, usersRes] = await Promise.all([
      postIds.length
        ? supabase.from('feed_post_media').select('post_id, url, media_type, position').in('post_id', postIds).order('position', { ascending: true })
        : Promise.resolve({ data: [] }),
      comentariosRecentesParaTargets('game', gameIds, bloqueados),
      comentariosRecentesParaTargets('post', postIds, bloqueados),
      reacoesParaTargets('game', gameIds, req.user.id),
      reacoesParaTargets('post', postIds, req.user.id),
      idsConhecidos.size
        ? supabase.from('users').select('id, nome, nome_jogador, email, avatar_url').in('id', [...idsConhecidos])
        : Promise.resolve({ data: [] }),
    ]);

    marcarFase(res, 'detalhes');

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
      const dt = g.data ? new Date(g.data) : null;
      const team = teamMap[g.team_id] || {};
      return {
        kind: 'jogo',
        id: g.id,
        created_at: g.created_at,
        date: g.data,
        time: dt ? dt.toISOString().slice(11, 16) : null, // HH:MM (UTC)
        location: g.local,
        team_id: g.team_id,
        team_name: team.nome || null,
        team_slug: team.slug || null,
        times_resultado: g.times_resultado,
        campeao_time_index: g.campeao_time_index,
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
        author_id: p.author_id,
        author_nome: nomeOf(p.author_id),
        author_avatar_url: avatarOf(p.author_id),
        body: p.body,
        tipo: p.tipo || 'post',
        conteudo: p.conteudo || null,
        media: mediaByPost[p.id] || [],
        contagem_reacoes: reacPosts[p.id]?.contagem || {},
        minha_reacao: reacPosts[p.id]?.minha || null,
        ...comentariosDe(comPosts[p.id]),
      };
    });

    // Mistura jogos + posts e ordena por created_at DESC
    const items = [...jogoItems, ...postItems].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    res.json({ items });
  })
);

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
    const texto = String(body ?? '').trim();
    const mediaList = (Array.isArray(media) ? media : []).filter((m) => m && m.url);
    // Texto é opcional QUANDO há média; vazio total é rejeitado.
    if (!texto && mediaList.length === 0) throw new HttpError(400, 'O post precisa de texto ou média.');
    if (texto.length > 2000) throw new HttpError(400, 'Máximo 2000 caracteres.');
    if (mediaList.length > 4) throw new HttpError(400, 'Máximo 4 anexos por post.');
    // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): só aceita URLs https do
    // Storage do Supabase ou do proxy do próprio backend (/api/media/) —
    // impede que o campo vire um redirect/SSRF para qualquer host.
    if (mediaList.some((m) => !urlDeMidiaValida(m.url, req))) {
      throw new HttpError(400, 'URL de mídia inválida.');
    }

    // Permissão: admin OU pode_postar
    const { data: membership } = await supabase
      .from('team_members')
      .select('role, pode_postar')
      .eq('team_id', teamId)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!membership) throw new HttpError(403, 'Você não é membro deste time.');
    if (membership.role !== 'admin' && !membership.pode_postar) {
      throw new HttpError(403, 'Você não tem permissão para publicar neste time.');
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
      .map((m, i) => ({
        post_id: post.id,
        url: String(m.url),
        media_type: POST_MEDIA.includes(m.media_type) ? m.media_type : 'image',
        position: Number.isFinite(Number(m.position)) ? Number(m.position) : i,
      }));
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

/** DELETE /api/feed/posts/:postId — apaga (autor ou admin da equipa). */
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
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    if (post.author_id !== req.user.id && role !== 'admin') {
      throw new HttpError(403, 'Só o autor ou um admin pode excluir.');
    }

    // Peça 2 (Tijolo 1B): antes do cascade na BD, junta as URLs da média para
    // apagar os OBJETOS no Storage — senão ficam órfãos, públicos e para sempre.
    const { data: media } = await supabase
      .from('feed_post_media')
      .select('url')
      .eq('post_id', post.id);

    // feed_post_media tem ON DELETE CASCADE (apaga as linhas)
    const { error } = await supabase.from('feed_posts').delete().eq('id', post.id);
    if (error) throw new HttpError(500, error.message);

    // Best-effort: mata os ficheiros no bucket. Se falhar, regista e segue — o
    // utilizador já viu o post desaparecer; não quebramos o fluxo por um órfão.
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
 * destaque/rodada de cerveja (só admin da equipa). Semântica PATCH:
 * só os campos enviados são actualizados.
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

    const b = req.body || {};
    const patch = {};

    if ('campeao_time_index' in b) {
      if (b.campeao_time_index === null) patch.campeao_time_index = null;
      else {
        const idx = parseInt(b.campeao_time_index, 10);
        if (!Number.isFinite(idx) || idx < 0) throw new HttpError(400, 'campeao_time_index inválido.');
        patch.campeao_time_index = idx;
      }
    }
    if ('campeao_foto_url' in b) {
      if (b.campeao_foto_url && !urlDeMidiaValida(b.campeao_foto_url, req)) {
        throw new HttpError(400, 'URL de mídia inválida.');
      }
      patch.campeao_foto_url = b.campeao_foto_url || null;
    }
    if ('artilheiro_user_id' in b) patch.artilheiro_user_id = b.artilheiro_user_id || null;
    if ('artilheiro_gols' in b) {
      if (b.artilheiro_gols === null || b.artilheiro_gols === '') patch.artilheiro_gols = null;
      else {
        const gols = parseInt(b.artilheiro_gols, 10);
        if (!Number.isFinite(gols) || gols < 0) throw new HttpError(400, 'artilheiro_gols inválido.');
        patch.artilheiro_gols = gols;
      }
    }
    if ('destaque_user_id' in b) patch.destaque_user_id = b.destaque_user_id || null;
    if ('destaque_titulo' in b) {
      const titulo = b.destaque_titulo == null ? null : String(b.destaque_titulo).trim();
      if (titulo && titulo.length > 60) throw new HttpError(400, 'destaque_titulo: máximo 60 caracteres.');
      patch.destaque_titulo = titulo || null;
    }
    if ('rodada_user_id' in b) patch.rodada_user_id = b.rodada_user_id || null;
    if ('rodada_foto_url' in b) {
      if (b.rodada_foto_url && !urlDeMidiaValida(b.rodada_foto_url, req)) {
        throw new HttpError(400, 'URL de mídia inválida.');
      }
      patch.rodada_foto_url = b.rodada_foto_url || null;
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
        artilheiro_nome: updated.artilheiro_user_id ? nomes[updated.artilheiro_user_id] || null : null,
        destaque_nome: updated.destaque_user_id ? nomes[updated.destaque_user_id] || null : null,
        rodada_nome: updated.rodada_user_id ? nomes[updated.rodada_user_id] || null : null,
      },
    });

    // Notifica todos os membros da equipa (fire-and-forget).
    supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', game.teams.id)
      .then(({ data }) =>
        enviarNotificacao((data || []).map((m) => m.user_id), {
          title: '🏆 Resultado registrado!',
          body: `Veja quem foi o destaque em ${game.local || 'Jogo'}`,
          url: '/feed',
        })
      );
  })
);

// =====================================================================
// UPLOAD DE FOTOS / VÍDEOS (Supabase Storage)
// =====================================================================

/**
 * POST /api/feed/upload — recebe um ficheiro (multipart, campo "file"),
 * envia-o ao bucket público do Supabase Storage e devolve a URL pública.
 */
router.post(
  '/api/feed/upload',
  requireAuth,
  receberFicheiro,
  filtroNSFW, // Tijolo 1: bloqueia imagem explícita da resenha antes de guardar
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Nenhum arquivo enviado.');
    const mimetypeOriginal = req.file.mimetype;
    const extOriginal = UPLOAD_MIME[mimetypeOriginal];
    if (!extOriginal) throw new HttpError(400, 'Tipo de arquivo não permitido.');

    // GIF: fica animado, não passa por sharp — mas tem teto PRÓPRIO, mais
    // apertado que o geral (a lei do app leve não abre exceção pra "é GIF").
    if (mimetypeOriginal === 'image/gif' && req.file.buffer.length > GIF_MAX_BYTES) {
      throw new HttpError(413, `GIF grande demais: o limite é ${GIF_MAX_BYTES / (1024 * 1024)}MB para manter a animação. Tente um arquivo menor.`);
    }

    const { buffer, mimetype, ext } = IMAGENS_COMPRIMIVEIS.has(mimetypeOriginal)
      ? await comprimirImagem(req.file.buffer, mimetypeOriginal, extOriginal)
      : { buffer: req.file.buffer, mimetype: mimetypeOriginal, ext: extOriginal };

    await ensureBucket();

    const filename = `${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filename, buffer, { contentType: mimetype, upsert: false });
    if (error) throw new HttpError(500, error.message);

    const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    // O tipo de mídia (para a UI) segue o arquivo ORIGINAL — comprimir um JPEG
    // para WebP não faz dele um "outro tipo", continua 'image'.
    const mediaType =
      mimetypeOriginal === 'image/gif' ? 'gif' : mimetypeOriginal.startsWith('video/') ? 'video' : 'image';

    res.status(201).json({ url: pub.publicUrl, media_type: mediaType });
  })
);

// =====================================================================
// REAÇÕES
// =====================================================================

/**
 * POST /api/feed/reacoes — toggle de reação num target.
 * Body: { target_type, target_id, emoji }. Mesmo emoji apaga; emoji
 * diferente actualiza; inexistente cria.
 */
router.post(
  '/api/feed/reacoes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { target_type: targetType, target_id: targetId, emoji } = req.body || {};
    if (!['comentario', 'game', 'post'].includes(targetType)) throw new HttpError(400, 'target_type inválido.');
    if (!targetId) throw new HttpError(400, 'target_id é obrigatório.');
    if (!REACTION_EMOJIS.includes(emoji)) throw new HttpError(400, 'Emoji não permitido.');

    const teamId = await targetTeamId(targetType, targetId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    await ensureUserRow(req.user);

    const { data: existing } = await supabase
      .from('reacoes')
      .select('id, emoji')
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    let minha = emoji;
    if (existing) {
      if (existing.emoji === emoji) {
        await supabase.from('reacoes').delete().eq('id', existing.id); // toggle off
        minha = null;
      } else {
        await supabase.from('reacoes').update({ emoji }).eq('id', existing.id);
        minha = emoji;
      }
    } else {
      const { error } = await supabase
        .from('reacoes')
        .insert({ target_type: targetType, target_id: targetId, user_id: req.user.id, emoji });
      if (error) throw new HttpError(500, error.message);
    }

    const map = await reacoesParaTargets(targetType, [targetId], req.user.id);
    res.json({ emoji: minha, contagem_reacoes: map[targetId]?.contagem || {} });
  })
);

// =====================================================================
// COMENTÁRIOS
// =====================================================================

/**
 * GET /api/feed/comentarios/:parentType/:parentId — lista comentários
 * (ASC). Os apagados vêm como { id, deleted: true } para preservar threads.
 */
router.get(
  '/api/feed/comentarios/:parentType/:parentId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parentType, parentId } = req.params;
    if (!['game', 'post'].includes(parentType)) throw new HttpError(400, 'parentType inválido.');

    const teamId = await parentTeamId(parentType, parentId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    // Bloqueio entre jogadores: comentários de quem está bloqueado/me bloqueou não existem para mim.
    const bloqueados = await conjuntoMutuo(req.user.id);

    const { data: rows } = await supabase
      .from('comentarios')
      .select('id, body, author_id, reply_to, mentioned_user_ids, created_at, deleted_at')
      .eq('parent_type', parentType)
      .eq('parent_id', parentId)
      .order('created_at', { ascending: true });
    const all = (rows || []).filter((c) => !bloqueados.has(c.author_id));
    const visiveis = all.filter((c) => !c.deleted_at);
    const ids = visiveis.map((c) => c.id);

    // Anexos dos comentários visíveis
    const anexosBy = {};
    if (ids.length) {
      const { data: ax } = await supabase
        .from('comentario_anexos')
        .select('comentario_id, url, media_type, position')
        .in('comentario_id', ids)
        .order('position', { ascending: true });
      for (const a of ax || []) {
        (anexosBy[a.comentario_id] ||= []).push({ url: a.url, media_type: a.media_type, position: a.position });
      }
    }

    // Autores
    const userIds = [...new Set(visiveis.map((c) => c.author_id).filter(Boolean))];
    const userMap = {};
    if (userIds.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador, email, avatar_url').in('id', userIds);
      for (const u of us || []) userMap[u.id] = u;
    }

    // Reações dos comentários
    const reac = await reacoesParaTargets('comentario', ids, req.user.id);

    const comentarios = all.map((c) => {
      if (c.deleted_at) return { id: c.id, deleted: true };
      const u = userMap[c.author_id];
      return {
        id: c.id,
        body: c.body,
        author_id: c.author_id,
        author_nome: u ? u.nome_jogador || u.nome || 'Jogador' : null,
        author_avatar_url: u?.avatar_url || null,
        reply_to: c.reply_to,
        mentioned_user_ids: c.mentioned_user_ids || [],
        created_at: c.created_at,
        anexos: anexosBy[c.id] || [],
        contagem_reacoes: reac[c.id]?.contagem || {},
        minha_reacao: reac[c.id]?.minha || null,
      };
    });

    res.json({ comentarios });
  })
);

/** POST /api/feed/comentarios — cria um comentário (membro da equipa). */
router.post(
  '/api/feed/comentarios',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parent_type: parentType, parent_id: parentId, body, reply_to: replyTo, anexos } = req.body || {};
    if (!['game', 'post'].includes(parentType)) throw new HttpError(400, 'parent_type inválido.');
    if (!parentId) throw new HttpError(400, 'parent_id é obrigatório.');
    const texto = String(body ?? '').trim();
    if (!texto) throw new HttpError(400, 'O comentário não pode estar vazio.');
    if (texto.length > 500) throw new HttpError(400, 'Máximo 500 caracteres.');

    const teamId = await parentTeamId(parentType, parentId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    // reply_to tem de pertencer ao mesmo parent
    if (replyTo) {
      const { data: parent } = await supabase
        .from('comentarios')
        .select('id, parent_type, parent_id')
        .eq('id', replyTo)
        .maybeSingle();
      if (!parent || parent.parent_type !== parentType || parent.parent_id !== parentId) {
        throw new HttpError(400, 'Comentário a responder inválido.');
      }
    }

    // Menções @<uuid> extraídas do corpo
    const mentioned = [...new Set([...texto.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];

    await ensureUserRow(req.user);

    const { data: c, error } = await supabase
      .from('comentarios')
      .insert({
        parent_type: parentType,
        parent_id: parentId,
        author_id: req.user.id,
        body: texto,
        reply_to: replyTo || null,
        mentioned_user_ids: mentioned,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Anexos (máx 8)
    const anexoRows = (Array.isArray(anexos) ? anexos : [])
      .filter((a) => a && a.url)
      .slice(0, 8)
      .map((a, i) => ({
        comentario_id: c.id,
        url: String(a.url),
        media_type: COMENTARIO_MEDIA.includes(a.media_type) ? a.media_type : 'image',
        position: i,
      }));
    let savedAnexos = [];
    if (anexoRows.length) {
      const { data: aa, error: ae } = await supabase
        .from('comentario_anexos')
        .insert(anexoRows)
        .select('url, media_type, position');
      if (ae) throw new HttpError(500, ae.message);
      savedAnexos = aa || [];
    }

    const author = await getUserById(req.user.id);
    res.status(201).json({
      comentario: {
        id: c.id,
        body: c.body,
        author_id: c.author_id,
        author_nome: author?.nome_jogador || author?.nome || 'Jogador',
        author_avatar_url: author?.avatar_url || null,
        reply_to: c.reply_to,
        mentioned_user_ids: c.mentioned_user_ids || [],
        created_at: c.created_at,
        anexos: savedAnexos,
        contagem_reacoes: {},
        minha_reacao: null,
      },
    });
  })
);

/**
 * DELETE /api/feed/comentarios/:comentarioId — soft delete (autor ou admin).
 * Marca deleted_at/updated_at; não apaga fisicamente (preserva threads).
 */
router.delete(
  '/api/feed/comentarios/:comentarioId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: c } = await supabase
      .from('comentarios')
      .select('id, parent_type, parent_id, author_id, deleted_at')
      .eq('id', req.params.comentarioId)
      .maybeSingle();
    if (!c) throw new HttpError(404, 'Comentário não encontrado.');

    const teamId = await parentTeamId(c.parent_type, c.parent_id);
    const role = teamId ? await getRole(teamId, req.user.id) : null;
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    if (c.author_id !== req.user.id && role !== 'admin') {
      throw new HttpError(403, 'Só o autor ou um admin pode excluir.');
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('comentarios')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', c.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

// =====================================================================
// DENÚNCIAS
// =====================================================================

/**
 * POST /api/feed/denuncias — denuncia um comentário ou post.
 * UNIQUE (target, reporter) garante uma denúncia por utilizador (23505 → idempotente).
 */
router.post(
  '/api/feed/denuncias',
  requireAuth,
  denunciaLimiter,
  asyncHandler(async (req, res) => {
    const { target_type: targetType, target_id: targetId, motivo, descricao } = req.body || {};
    if (!['comentario', 'post'].includes(targetType)) throw new HttpError(400, 'target_type inválido.');
    if (!targetId) throw new HttpError(400, 'target_id é obrigatório.');
    if (!DENUNCIA_MOTIVOS.includes(motivo)) throw new HttpError(400, 'Motivo inválido.');
    const desc = descricao == null ? null : String(descricao).trim().slice(0, 500) || null;

    const teamId = await targetTeamId(targetType, targetId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    await ensureUserRow(req.user);

    const { error } = await supabase
      .from('denuncias')
      .insert({ target_type: targetType, target_id: targetId, reporter_id: req.user.id, motivo, descricao: desc });
    if (error) {
      if (error.code === '23505') return res.json({ reported: true }); // já denunciado — idempotente
      throw new HttpError(500, error.message);
    }
    res.json({ reported: true });
  })
);

/**
 * GET /api/feed/denuncias — denúncias por resolver das equipas onde o
 * utilizador é admin. Inclui o conteúdo denunciado e o nome do reporter.
 */
router.get(
  '/api/feed/denuncias',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Equipas onde sou admin.
    const { data: adminRows } = await supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', req.user.id)
      .eq('role', 'admin');
    const adminTeams = new Set((adminRows || []).map((r) => r.team_id));
    if (!adminTeams.size) return res.json({ denuncias: [] });

    const { data: rows, error } = await supabase
      .from('denuncias')
      .select('id, target_type, target_id, motivo, descricao, reporter_id, created_at')
      .eq('resolvida', false)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    // Filtra pelas denúncias cujo alvo pertence a uma equipa que administro.
    const visiveis = [];
    for (const d of rows || []) {
      const teamId = await targetTeamId(d.target_type, d.target_id);
      if (teamId && adminTeams.has(teamId)) visiveis.push(d);
    }

    // Nomes dos reporters.
    const reporterIds = [...new Set(visiveis.map((d) => d.reporter_id).filter(Boolean))];
    const repMap = {};
    if (reporterIds.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador, email').in('id', reporterIds);
      for (const u of us || []) repMap[u.id] = u.nome_jogador || u.nome || 'Jogador';
    }

    // Conteúdo denunciado (texto do comentário/post).
    const comIds = visiveis.filter((d) => d.target_type === 'comentario').map((d) => d.target_id);
    const postIds = visiveis.filter((d) => d.target_type === 'post').map((d) => d.target_id);
    const conteudo = {};
    if (comIds.length) {
      const { data: cs } = await supabase.from('comentarios').select('id, body').in('id', comIds);
      for (const c of cs || []) conteudo[`comentario:${c.id}`] = c.body;
    }
    if (postIds.length) {
      const { data: ps } = await supabase.from('feed_posts').select('id, body').in('id', postIds);
      for (const p of ps || []) conteudo[`post:${p.id}`] = p.body;
    }

    const denuncias = visiveis.map((d) => ({
      id: d.id,
      target_type: d.target_type,
      target_id: d.target_id,
      motivo: d.motivo,
      descricao: d.descricao,
      reporter_nome: d.reporter_id ? repMap[d.reporter_id] || null : null,
      created_at: d.created_at,
      conteudo: conteudo[`${d.target_type}:${d.target_id}`] ?? null,
    }));
    res.json({ denuncias });
  })
);

/**
 * PATCH /api/feed/denuncias/:id/resolver — resolve uma denúncia (só admin da
 * equipa do alvo). Body: { apagar_conteudo }. Se true: soft-delete do
 * comentário ou apaga o post.
 */
router.patch(
  '/api/feed/denuncias/:id/resolver',
  requireAuth,
  asyncHandler(async (req, res) => {
    const apagar = !!(req.body && req.body.apagar_conteudo);

    const { data: d } = await supabase
      .from('denuncias')
      .select('id, target_type, target_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!d) throw new HttpError(404, 'Denúncia não encontrada.');

    const teamId = await targetTeamId(d.target_type, d.target_id);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem resolver denúncias.');

    if (apagar) {
      if (d.target_type === 'comentario') {
        const now = new Date().toISOString();
        await supabase.from('comentarios').update({ deleted_at: now, updated_at: now }).eq('id', d.target_id);
      } else if (d.target_type === 'post') {
        await supabase.from('feed_posts').delete().eq('id', d.target_id);
      }
    }

    const { error } = await supabase.from('denuncias').update({ resolvida: true }).eq('id', d.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ resolvida: true });
  })
);

module.exports = router;
