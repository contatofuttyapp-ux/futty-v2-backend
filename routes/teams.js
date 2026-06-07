// Futty v2.0 — Rotas de equipas e convites.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, requireTeamMember } = require('../utils/db');
const { slugify } = require('../utils/helpers');

const router = express.Router();

const CORES_VALIDAS = ['verde', 'azul', 'vermelho', 'preto'];
const MODOS_VISIBILIDADE = ['privado', 'publico_aprovacao', 'publico_aberto'];
const CONVITE_DIAS = 7;

// Upload do logo da equipa (em memória; gravado depois no disco em public/logos).
const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => cb(null, !!LOGO_EXT[file.mimetype]),
});
// Wrapper que converte erros do multer (ex.: tamanho) em HttpError(400).
function logoMiddleware(req, res, next) {
  uploadLogo.single('logo')(req, res, (err) => {
    if (err) {
      return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Logo: máximo 2MB.' : 'Ficheiro inválido.'));
    }
    next();
  });
}

/** POST /api/teams — cria uma equipa e adiciona o criador como admin. */
router.post(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { nome, cor, publica, localizacao, descricao } = req.body || {};
    if (!nome || !nome.trim()) throw new HttpError(400, 'O nome da equipa é obrigatório.');
    const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';
    const localizacaoFinal = localizacao ? String(localizacao).trim().slice(0, 100) : null;
    const descricaoFinal = descricao ? String(descricao).trim().slice(0, 300) : null;

    await ensureUserRow(req.user);

    // Cria a equipa (com retry se o slug colidir)
    let team = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !team; attempt += 1) {
      const slug = slugify(nome);
      const { data, error } = await supabase
        .from('teams')
        .insert({
          nome: nome.trim(),
          slug,
          cor: corFinal,
          criado_por: req.user.id,
          publica: !!publica,
          localizacao: localizacaoFinal,
          descricao: descricaoFinal,
        })
        .select()
        .single();
      if (!error) team = data;
      else if (error.code === '23505') lastError = error; // slug duplicado -> tenta de novo
      else throw new HttpError(500, error.message);
    }
    if (!team) throw new HttpError(500, lastError?.message || 'Não foi possível criar a equipa.');

    // Adiciona o criador como admin (rollback se falhar)
    const { error: memberError } = await supabase
      .from('team_members')
      .insert({ user_id: req.user.id, team_id: team.id, role: 'admin' });
    if (memberError) {
      await supabase.from('teams').delete().eq('id', team.id);
      throw new HttpError(500, memberError.message);
    }

    res.status(201).json({ team });
  })
);

/** GET /api/teams — lista as equipas de que o utilizador é membro. */
router.get(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('team_members')
      .select('role, teams ( id, nome, slug, cor, criado_por, created_at, logo_url, cor_fundo, modo_visibilidade )')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const teams = (data || [])
      .filter((row) => row.teams)
      .map((row) => ({ ...row.teams, role: row.role }));
    res.json({ teams });
  })
);

/**
 * GET /api/teams/explorar — equipas públicas (pesquisa por nome/cidade).
 * Registado ANTES de /api/teams/:slug para não colidir com o param :slug.
 */
router.get(
  '/api/teams/explorar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const loc = String(req.query.localizacao ?? '').trim();

    let query = supabase
      .from('teams')
      .select('id, nome, slug, cor, localizacao, descricao, logo_url, cor_fundo, modo_visibilidade')
      .in('modo_visibilidade', ['publico_aprovacao', 'publico_aberto']);
    // q pesquisa em nome OU localização (a barra única diz "nome ou cidade").
    if (q) query = query.or(`nome.ilike.%${q}%,localizacao.ilike.%${q}%`);
    if (loc) query = query.ilike('localizacao', `%${loc}%`);

    const { data: teams, error } = await query;
    if (error) throw new HttpError(500, error.message);

    const ids = (teams || []).map((t) => t.id);
    const counts = {};
    const meus = new Set();
    if (ids.length) {
      const { data: mem } = await supabase.from('team_members').select('team_id, user_id').in('team_id', ids);
      for (const m of mem || []) {
        counts[m.team_id] = (counts[m.team_id] || 0) + 1;
        if (m.user_id === req.user.id) meus.add(m.team_id);
      }
    }
    const pendentes = new Set();
    if (ids.length) {
      const { data: reqs } = await supabase
        .from('team_join_requests')
        .select('team_id')
        .eq('user_id', req.user.id)
        .eq('status', 'pending')
        .in('team_id', ids);
      for (const r of reqs || []) pendentes.add(r.team_id);
    }

    const lista = (teams || [])
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        slug: t.slug,
        cor: t.cor,
        logo_url: t.logo_url || null,
        cor_fundo: t.cor_fundo || null,
        modo_visibilidade: t.modo_visibilidade,
        localizacao: t.localizacao,
        descricao: t.descricao,
        membro_count: counts[t.id] || 0,
        ja_membro: meus.has(t.id),
        pedido_pendente: pendentes.has(t.id),
      }))
      .sort((a, b) => b.membro_count - a.membro_count);

    res.json({ teams: lista });
  })
);

/**
 * GET /api/teams/publicas — equipas públicas com nº de membros e último jogo,
 * ordenadas por recência do último jogo (7d > 30d > resto) e depois nº membros.
 * Equivalente ao SQL do briefing (feito em JS — o cliente Supabase não faz GROUP BY).
 * Registado ANTES de /api/teams/:slug para não colidir com o param :slug.
 */
router.get(
  '/api/teams/publicas',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, nome, slug, descricao, localizacao, logo_url, cor_fundo, modo_visibilidade')
      .in('modo_visibilidade', ['publico_aberto', 'publico_aprovacao']);
    if (error) throw new HttpError(500, error.message);

    const lista = teams || [];
    const ids = lista.map((t) => t.id);

    const membros = {};
    const ultimoJogoTs = {};
    if (ids.length) {
      const { data: tm } = await supabase.from('team_members').select('team_id, user_id').in('team_id', ids);
      for (const m of tm || []) membros[m.team_id] = (membros[m.team_id] || 0) + 1;

      const { data: gs } = await supabase.from('games').select('team_id, data').in('team_id', ids).is('cancelado_at', null);
      for (const g of gs || []) {
        const ts = g.data ? new Date(g.data).getTime() : 0;
        if (ts > (ultimoJogoTs[g.team_id] || 0)) ultimoJogoTs[g.team_id] = ts;
      }
    }

    const now = Date.now();
    const cut7 = now - 7 * 86400000;
    const cut30 = now - 30 * 86400000;
    const bucket = (ts) => (ts > cut7 ? 1 : ts > cut30 ? 2 : 3);

    const out = lista
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        slug: t.slug,
        descricao: t.descricao,
        localizacao: t.localizacao,
        logo_url: t.logo_url || null,
        cor_fundo: t.cor_fundo || null,
        modo_visibilidade: t.modo_visibilidade,
        numero_membros: membros[t.id] || 0,
        ultimo_jogo: ultimoJogoTs[t.id] ? new Date(ultimoJogoTs[t.id]).toISOString() : null,
      }))
      .sort((a, b) => {
        const ba = bucket(ultimoJogoTs[a.id] || 0);
        const bb = bucket(ultimoJogoTs[b.id] || 0);
        if (ba !== bb) return ba - bb;
        return b.numero_membros - a.numero_membros;
      });

    res.json({ teams: out });
  })
);

/** GET /api/teams/:slug — detalhes da equipa + lista de membros (só membros). */
router.get(
  '/api/teams/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(
      req.params.slug,
      'id, nome, slug, cor, criado_por, created_at, publica, localizacao, descricao, logo_url, cor_fundo, modo_visibilidade'
    );
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    const { data: rawMembers, error } = await supabase
      .from('team_members')
      .select('role, created_at, users ( id, nome, email, avatar_url )')
      .eq('team_id', team.id)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const members = (rawMembers || []).map((m) => ({
      id: m.users?.id,
      nome: m.users?.nome,
      email: m.users?.email,
      avatar_url: m.users?.avatar_url,
      role: m.role,
      created_at: m.created_at,
    }));

    res.json({ team: { ...team, role }, members });
  })
);

/** PATCH /api/teams/:slug — edita a equipa (só admin). */
router.patch(
  '/api/teams/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar a equipa.');

    const b = req.body || {};
    const patch = {};
    if ('nome' in b) {
      const v = String(b.nome ?? '').trim();
      if (!v) throw new HttpError(400, 'O nome não pode ser vazio.');
      if (v.length > 60) throw new HttpError(400, 'Nome: máximo 60 caracteres.');
      patch.nome = v;
    }
    if ('cor' in b) {
      if (!CORES_VALIDAS.includes(b.cor)) throw new HttpError(400, 'Cor inválida.');
      patch.cor = b.cor;
    }
    if ('publica' in b) patch.publica = !!b.publica;
    if ('localizacao' in b) patch.localizacao = b.localizacao ? String(b.localizacao).trim().slice(0, 100) : null;
    if ('descricao' in b) patch.descricao = b.descricao ? String(b.descricao).trim().slice(0, 300) : null;
    if ('cor_fundo' in b) {
      const v = b.cor_fundo == null ? null : String(b.cor_fundo).trim();
      if (v && v.length > 20) throw new HttpError(400, 'cor_fundo inválida.');
      patch.cor_fundo = v || null;
    }
    if ('modo_visibilidade' in b) {
      if (!MODOS_VISIBILIDADE.includes(b.modo_visibilidade)) throw new HttpError(400, 'modo_visibilidade inválido.');
      patch.modo_visibilidade = b.modo_visibilidade;
      // Mantém a flag legada `publica` coerente (true para os dois modos públicos).
      patch.publica = b.modo_visibilidade !== 'privado';
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase.from('teams').update(patch).eq('id', team.id).select().single();
    if (error) throw new HttpError(500, error.message);
    res.json({ team: updated });
  })
);

/** POST /api/teams/:slug/logo — carrega o logo da equipa (só admin; PNG/JPG/WEBP, máx 2MB). */
router.post(
  '/api/teams/:slug/logo',
  requireAuth,
  logoMiddleware,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem mudar o logo.');

    if (!req.file) throw new HttpError(400, 'Envia uma imagem PNG, JPG ou WEBP (máx 2MB).');
    const ext = LOGO_EXT[req.file.mimetype];

    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGOS_DIR, `${team.id}.${ext}`), req.file.buffer);
    const logoUrl = `/public/logos/${team.id}.${ext}`;

    const { error } = await supabase.from('teams').update({ logo_url: logoUrl }).eq('id', team.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ logo_url: logoUrl });
  })
);

/**
 * GET /api/teams/:slug/membros — membros com role/stats (qualquer membro).
 * Ordena: admins primeiro, depois por nome.
 */
router.get(
  '/api/teams/:slug/membros',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    const { data, error } = await supabase
      .from('team_members')
      .select('id, role, pode_postar, categoria, visivel_ranking, nota_interna, gols, artilharia, vitorias, destaque, users ( id, nome, nome_jogador, avatar_url, email )')
      .eq('team_id', team.id);
    if (error) throw new HttpError(500, error.message);

    const membros = (data || []).map((m) => ({
      id: m.id,
      user_id: m.users?.id,
      role: m.role,
      pode_postar: !!m.pode_postar,
      categoria: m.categoria || 'linha',
      visivel_ranking: m.visivel_ranking !== false,
      nota_interna: m.nota_interna || null,
      nome: m.users?.nome || null,
      nome_jogador: m.users?.nome_jogador || null,
      avatar_url: m.users?.avatar_url || null,
      email: m.users?.email || null,
      gols: m.gols ?? 0,
      artilharia: m.artilharia ?? 0,
      vitorias: m.vitorias ?? 0,
      destaque: m.destaque ?? 0,
    }));
    membros.sort((a, b) => {
      if ((a.role === 'admin') !== (b.role === 'admin')) return a.role === 'admin' ? -1 : 1;
      return String(a.nome_jogador || a.nome || '').localeCompare(String(b.nome_jogador || b.nome || ''), 'pt', { sensitivity: 'base' });
    });
    res.json({ membros });
  })
);

/** DELETE /api/teams/:slug/membros/:userId — remove um membro (só admin). */
router.delete(
  '/api/teams/:slug/membros/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem remover membros.');
    if (req.params.userId === req.user.id) throw new HttpError(400, 'Não te podes remover a ti próprio.');

    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', team.id)
      .eq('user_id', req.params.userId);
    if (error) throw new HttpError(500, error.message);
    res.json({ removed: true });
  })
);

/** PATCH /api/teams/:slug/membros/:userId — muda role/pode_postar (só admin). */
router.patch(
  '/api/teams/:slug/membros/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar membros.');

    const b = req.body || {};
    const patch = {};
    if ('role' in b) {
      if (!['admin', 'member'].includes(b.role)) throw new HttpError(400, 'role inválido.');
      if (req.params.userId === req.user.id) throw new HttpError(400, 'Não podes mudar o teu próprio role.');
      patch.role = b.role;
    }
    if ('pode_postar' in b) patch.pode_postar = !!b.pode_postar;
    if ('categoria' in b) {
      if (!['linha', 'GR'].includes(b.categoria)) throw new HttpError(400, 'categoria inválida.');
      patch.categoria = b.categoria;
    }
    if ('visivel_ranking' in b) patch.visivel_ranking = !!b.visivel_ranking;
    if ('nota_interna' in b) {
      const v = b.nota_interna == null ? null : String(b.nota_interna).trim();
      if (v && v.length > 200) throw new HttpError(400, 'Nota interna: máximo 200 caracteres.');
      patch.nota_interna = v || null;
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase
      .from('team_members')
      .update(patch)
      .eq('team_id', team.id)
      .eq('user_id', req.params.userId)
      .select('id, user_id, role, pode_postar, categoria, visivel_ranking, nota_interna')
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(404, 'Membro não encontrado.');
    res.json({ membro: updated });
  })
);

/** POST /api/teams/:slug/convite — gera um token de convite (qualquer membro). */
router.post(
  '/api/teams/:slug/convite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CONVITE_DIAS * 86400000).toISOString();

    const { data: convite, error } = await supabase
      .from('convites')
      .insert({ team_id: team.id, token, criado_por: req.user.id, expires_at: expiresAt })
      .select('token, expires_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.status(201).json({ token: convite.token, expires_at: convite.expires_at });
  })
);

/**
 * GET /api/convite/:token — valida um convite (público; auth opcional).
 * Devolve sempre 200 com { valido, motivo, ... }.
 */
router.get(
  '/api/convite/:token',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { data: convite } = await supabase
      .from('convites')
      .select('id, team_id, criado_por, usado_por, expires_at')
      .eq('token', req.params.token)
      .maybeSingle();

    if (!convite) {
      return res.json({ valido: false, motivo: 'nao_encontrado', team: null });
    }

    const { data: team } = await supabase
      .from('teams')
      .select('id, nome, slug, cor')
      .eq('id', convite.team_id)
      .single();
    const { data: inviter } = await supabase
      .from('users')
      .select('nome, email')
      .eq('id', convite.criado_por)
      .maybeSingle();

    let motivo = null;
    if (convite.usado_por) motivo = 'usado';
    else if (new Date(convite.expires_at).getTime() < Date.now()) motivo = 'expirado';

    let jaMembro = false;
    if (req.user && team) {
      const role = await getRole(team.id, req.user.id);
      jaMembro = !!role;
    }

    res.json({
      valido: motivo === null,
      motivo,
      autenticado: !!req.user,
      jaMembro,
      convidadoPor: inviter?.nome || inviter?.email || null,
      expires_at: convite.expires_at,
      team: team ? { nome: team.nome, slug: team.slug, cor: team.cor } : null,
    });
  })
);

/** POST /api/convite/:token/aceitar — entra na equipa e consome o convite. */
router.post(
  '/api/convite/:token/aceitar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: convite } = await supabase
      .from('convites')
      .select('id, team_id, usado_por, expires_at')
      .eq('token', req.params.token)
      .maybeSingle();
    if (!convite) throw new HttpError(404, 'Convite não encontrado.');

    const { data: team } = await supabase
      .from('teams')
      .select('id, slug, nome, cor')
      .eq('id', convite.team_id)
      .single();
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    await ensureUserRow(req.user);

    const teamResumo = { slug: team.slug, nome: team.nome, cor: team.cor };

    // Já é membro? -> idempotente, não consome o convite
    const existingRole = await getRole(team.id, req.user.id);
    if (existingRole) {
      return res.json({ jaMembro: true, team: teamResumo });
    }

    // Valida o estado do convite (apenas para novos membros)
    if (convite.usado_por) throw new HttpError(400, 'Este convite já foi utilizado.');
    if (new Date(convite.expires_at).getTime() < Date.now()) {
      throw new HttpError(400, 'Este convite expirou.');
    }

    // Adiciona como membro
    const { error: memberError } = await supabase
      .from('team_members')
      .insert({ user_id: req.user.id, team_id: team.id, role: 'member' });
    if (memberError) {
      if (memberError.code === '23505') {
        return res.json({ jaMembro: true, team: teamResumo }); // corrida: já é membro
      }
      throw new HttpError(500, memberError.message);
    }

    // Marca o convite como usado
    await supabase.from('convites').update({ usado_por: req.user.id }).eq('id', convite.id);

    res.status(201).json({ jaMembro: false, team: teamResumo });
  })
);

/** POST /api/teams/:slug/pedir-entrada — pedir entrada numa equipa pública. */
router.post(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, modo_visibilidade');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    if (team.modo_visibilidade === 'privado') throw new HttpError(403, 'Esta equipa não é pública.');

    const role = await getRole(team.id, req.user.id);
    if (role) throw new HttpError(400, 'Já és membro desta equipa.');

    await ensureUserRow(req.user);

    // Equipa aberta: entra já como membro, sem pedido pendente.
    if (team.modo_visibilidade === 'publico_aberto') {
      const { error: me } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, user_id: req.user.id, role: 'member' }, { onConflict: 'user_id,team_id' });
      if (me) throw new HttpError(500, me.message);
      return res.status(201).json({ entrou: true });
    }

    const mensagem = req.body?.mensagem ? String(req.body.mensagem).trim().slice(0, 300) : null;

    const { data, error } = await supabase
      .from('team_join_requests')
      .insert({ team_id: team.id, user_id: req.user.id, mensagem, status: 'pending' })
      .select('id, status')
      .single();

    if (error) {
      // UNIQUE (team_id, user_id): já existe um pedido.
      if (error.code === '23505') {
        const { data: existente } = await supabase
          .from('team_join_requests')
          .select('id, status')
          .eq('team_id', team.id)
          .eq('user_id', req.user.id)
          .maybeSingle();
        // Se tinha sido rejeitado, reabre (volta a pending).
        if (existente?.status === 'rejected') {
          const { data: reaberto } = await supabase
            .from('team_join_requests')
            .update({ status: 'pending', mensagem, updated_at: new Date().toISOString() })
            .eq('id', existente.id)
            .select('id, status')
            .single();
          return res.json({ pedido: reaberto || existente });
        }
        return res.json({ pedido: existente || { id: null, status: 'pending' } });
      }
      throw new HttpError(500, error.message);
    }

    res.status(201).json({ pedido: data });
  })
);

/** GET /api/teams/:slug/pedidos — pedidos pendentes (só admin). */
router.get(
  '/api/teams/:slug/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os pedidos.');

    const { data, error } = await supabase
      .from('team_join_requests')
      .select('id, user_id, mensagem, created_at, users ( id, nome, avatar_url, nome_jogador )')
      .eq('team_id', team.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const pedidos = (data || []).map((p) => ({
      id: p.id,
      user_id: p.user_id,
      nome: p.users?.nome || p.users?.nome_jogador || null,
      nome_jogador: p.users?.nome_jogador || null,
      avatar_url: p.users?.avatar_url || null,
      mensagem: p.mensagem,
      created_at: p.created_at,
    }));
    res.json({ pedidos });
  })
);

/** PATCH /api/teams/:slug/pedidos/:pedidoId — aprovar/rejeitar (só admin). */
router.patch(
  '/api/teams/:slug/pedidos/:pedidoId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'status inválido.');

    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem decidir pedidos.');

    const { data: pedido } = await supabase
      .from('team_join_requests')
      .select('id, team_id, user_id, status')
      .eq('id', req.params.pedidoId)
      .maybeSingle();
    if (!pedido || pedido.team_id !== team.id) throw new HttpError(404, 'Pedido não encontrado.');

    // Aprovado → adiciona como membro (idempotente).
    if (status === 'approved') {
      const { error: me } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, user_id: pedido.user_id, role: 'member' }, { onConflict: 'user_id,team_id' });
      if (me) throw new HttpError(500, me.message);
    }

    const { data: updated, error } = await supabase
      .from('team_join_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pedido.id)
      .select('id, status, updated_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ pedido: updated });
  })
);

/** GET /api/teams/:slug/convites — convites activos (não usados, não expirados). */
router.get(
  '/api/teams/:slug/convites',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os convites.');

    const nowIso = new Date().toISOString();
    const { data: convites, error } = await supabase
      .from('convites')
      .select('id, token, created_at, expires_at, criado_por')
      .eq('team_id', team.id)
      .is('usado_por', null)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    // Nomes dos criadores (criado_por).
    const ids = [...new Set((convites || []).map((c) => c.criado_por).filter(Boolean))];
    const nomeMap = {};
    if (ids.length) {
      const { data: us } = await supabase.from('users').select('id, nome, email').in('id', ids);
      for (const u of us || []) nomeMap[u.id] = u.nome || u.email;
    }

    const lista = (convites || []).map((c) => ({
      id: c.id,
      token: c.token,
      criado_por_nome: c.criado_por ? nomeMap[c.criado_por] || null : null,
      created_at: c.created_at,
      expires_at: c.expires_at,
    }));
    res.json({ convites: lista });
  })
);

/** DELETE /api/teams/:slug/convites/:conviteId — revoga um convite (só admin). */
router.delete(
  '/api/teams/:slug/convites/:conviteId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem revogar convites.');

    const { data: conv } = await supabase
      .from('convites')
      .select('id, team_id')
      .eq('id', req.params.conviteId)
      .maybeSingle();
    if (!conv || conv.team_id !== team.id) throw new HttpError(404, 'Convite não encontrado.');

    const { error } = await supabase.from('convites').delete().eq('id', conv.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

/** GET /api/teams/:slug/stats — estatísticas agregadas da equipa (só admin). */
router.get(
  '/api/teams/:slug/stats',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver as estatísticas.');

    // Jogos da equipa.
    const { data: games } = await supabase
      .from('games')
      .select('id, data, local, status')
      .eq('team_id', team.id);
    const ativos = (games || []).filter((g) => g.status !== 'cancelado');

    // Membros (com stats + dados do utilizador).
    const { data: members } = await supabase
      .from('team_members')
      .select('user_id, gols, users ( nome, nome_jogador, avatar_url )')
      .eq('team_id', team.id);
    const total_membros = (members || []).length;

    // Confirmações por jogo e por utilizador.
    const gameIds = (games || []).map((g) => g.id);
    const confByGame = {};
    const confByUser = {};
    if (gameIds.length) {
      const { data: gp } = await supabase
        .from('game_players')
        .select('game_id, user_id, confirmado')
        .in('game_id', gameIds);
      for (const p of gp || []) {
        if (!p.confirmado) continue;
        confByGame[p.game_id] = (confByGame[p.game_id] || 0) + 1;
        confByUser[p.user_id] = (confByUser[p.user_id] || 0) + 1;
      }
    }

    const totalConf = ativos.reduce((s, g) => s + (confByGame[g.id] || 0), 0);
    const media_confirmacoes = ativos.length ? Math.round((totalConf / ativos.length) * 10) / 10 : 0;

    // Artilheiro: membro com mais gols.
    let artilheiro = null;
    for (const m of members || []) {
      if ((m.gols || 0) > 0 && (!artilheiro || m.gols > artilheiro.gols)) {
        artilheiro = { nome: m.users?.nome_jogador || m.users?.nome || null, avatar_url: m.users?.avatar_url || null, gols: m.gols };
      }
    }

    // Mais presente: membro com mais jogos confirmados.
    let maisUserId = null;
    let maxPres = 0;
    for (const [uid, n] of Object.entries(confByUser)) {
      if (n > maxPres) {
        maxPres = n;
        maisUserId = uid;
      }
    }
    let mais_presente = null;
    if (maisUserId) {
      const m = (members || []).find((x) => x.user_id === maisUserId);
      mais_presente = { nome: m?.users?.nome_jogador || m?.users?.nome || null, avatar_url: m?.users?.avatar_url || null, jogos: maxPres };
    }

    // Próximo jogo futuro.
    const now = Date.now();
    const futuros = (games || [])
      .filter((g) => g.data && new Date(g.data).getTime() > now && g.status !== 'cancelado')
      .sort((a, b) => new Date(a.data) - new Date(b.data));
    let proximo_jogo = null;
    if (futuros[0]) {
      const g = futuros[0];
      const d = new Date(g.data);
      const pad = (n) => String(n).padStart(2, '0');
      proximo_jogo = {
        id: g.id,
        date: g.data,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        location: g.local,
        confirmados: confByGame[g.id] || 0,
      };
    }

    res.json({
      stats: {
        total_jogos: ativos.length,
        total_membros,
        media_confirmacoes,
        artilheiro,
        mais_presente,
        proximo_jogo,
      },
    });
  })
);

module.exports = router;
