// Futty v2.0 — Rotas de equipas e convites.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { conviteLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, requireTeamMember } = require('../utils/db');
const { obterTeams, obterPedidos } = require('../services/inicio');
const { agregadosDaEquipa } = require('../utils/agregados');
const { filtroNSFWFailClosed } = require('../utils/nsfwFilter');
const { verificarImagemReal } = require('../utils/imagemReal');
const { resolverCidade, lerEscolhaDaLista, normalizarCidade, condicaoPorCidade, lerBairro, resolverBairro } = require('../utils/cidade');
const { slugify, notaParaExibir } = require('../utils/helpers');
const plataforma = require('../utils/plataformaStore');
const selosCache = require('../utils/selosCache');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const { escolherUniforme } = require('../utils/uniformeDoPacote');
const { idsQueSoOrganizam } = require('../utils/soOrganiza');
const { enviarNotificacao } = require('./push'); // o "Você entrou no <time>!" do aceite de pedido (Rodada 29D)
const { criarCodigo, convitePorParametro, codigosDosConvites } = require('../utils/conviteCodigo'); // o link curto /c/<código> (29H)

const router = express.Router();

const CORES_VALIDAS = ['verde', 'azul', 'vermelho', 'preto'];
const MODOS_VISIBILIDADE = ['privado', 'publico_aprovacao', 'publico_aberto'];
// RODADA 20 (23-set, decisão do dono): o link vira "de grupo" — o MESMO link
// serve pra todo mundo, vale 30 dias (era 7, uso único), e o admin revoga
// quando quiser (DELETE /api/teams/:slug/convites/:id, já existia).
const CONVITE_DIAS = 30;

// Escapa um valor para uso dentro da string de filtro do .or() do PostgREST.
// Vírgula separa condições, parênteses agrupam, ponto separa
// coluna.operador.valor — um valor com qualquer um deles precisa vir entre
// aspas duplas (sintaxe suportada pelo PostgREST) para ser lido como valor
// literal em vez de sintaxe de filtro.
function valorFiltroOr(valor) {
  if (/[,.()]/.test(valor)) return `"${valor.replace(/"/g, '\\"')}"`;
  return valor;
}

// Upload do logo da equipa (em memória; gravado no bucket privado "avatars").
const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => cb(null, !!LOGO_EXT[file.mimetype]),
});
// Wrapper que converte erros do multer (ex.: tamanho) em HttpError(400).
function logoMiddleware(req, res, next) {
  uploadLogo.single('logo')(req, res, (err) => {
    if (err) {
      return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Logo: máximo 2MB.' : 'Arquivo inválido.'));
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
    if (!nome || !nome.trim()) throw new HttpError(400, 'O nome do time é obrigatório.');
    const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';
    const localizacaoFinal = localizacao ? String(localizacao).trim().slice(0, 100) : null;
    const descricaoFinal = descricao ? String(descricao).trim().slice(0, 300) : null;

    // GEO (14-set, mesma regra do PATCH /api/teams/:slug): guarda o nome da CIDADE (texto) + o ponto ARREDONDADO
    // (a morada exacta nunca entra). RODADA 29B (D), regra completa em utils/cidade.js: cidade DA LISTA do app →
    // a coordenada vem da lista (sem Nominatim); fora dela → Nominatim; se nada achar, guarda só o texto (normalizado
    // em `cidade_normalizada`, para o Explorar casar por texto) e segue — nunca bloqueia a criação do time.
    const cid = await resolverCidade(req.body || {});
    const cidadeFinal = cid.cidade;
    // RODADA 29H (item 12): o bairro opcional. Achou perto da cidade → o ponto do time é o do bairro; senão fica o da cidade.
    const bar = await resolverBairro(req.body || {}, cid);
    const geoLat = bar.geo?.lat ?? cid.geo?.lat ?? null;
    const geoLng = bar.geo?.lng ?? cid.geo?.lng ?? null;
    // Colunas da migração 073 (bairro e os dois prêmios do time): só vão no insert quando há o que gravar; sem a migração o
    // time nasce igual, sem elas, e a resposta diz o que ficou de fora (`bairro.salvo`, `premios_salvos`).
    const extras = {};
    if (bar.bairro) { extras.bairro = bar.bairro; extras.bairro_normalizado = bar.normalizado; }
    if (req.body?.mostrar_artilheiro === false) extras.mostrar_artilheiro = false;
    if (req.body?.mostrar_destaque === false) extras.mostrar_destaque = false;
    let extrasGravados = true;

    await ensureUserRow(req.user);

    // Cria a equipa (com retry se o slug colidir)
    let team = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !team; attempt += 1) {
      const slug = slugify(nome);
      const linhaDoTime = {
        nome: nome.trim(),
        slug,
        cor: corFinal,
        criado_por: req.user.id,
        publica: !!publica,
        localizacao: localizacaoFinal,
        descricao: descricaoFinal,
      };
      const colunasDaCidade = { cidade: cidadeFinal, cidade_normalizada: cid.normalizada, geo_lat: geoLat, geo_lng: geoLng };
      let { data, error } = await supabase
        .from('teams')
        .insert({ ...linhaDoTime, ...colunasDaCidade, ...extras })
        .select()
        .single();
      // Migração 073 por aplicar: sem as colunas do bairro e dos prêmios o time nasce igual, só sem elas.
      if (error && Object.keys(extras).length && /bairro|mostrar_artilheiro|mostrar_destaque/i.test(error.message || '')) {
        extrasGravados = false;
        ({ data, error } = await supabase
          .from('teams')
          .insert({ ...linhaDoTime, ...colunasDaCidade })
          .select()
          .single());
      }
      // Migração 066 por aplicar: sem `cidade_normalizada` o resto da cidade (texto e ponto) continua a valer.
      if (error && /cidade_normalizada/i.test(error.message || '')) {
        const { cidade_normalizada: _sem066, ...semNormalizada } = colunasDaCidade; // eslint-disable-line no-unused-vars
        ({ data, error } = await supabase
          .from('teams')
          .insert({ ...linhaDoTime, ...semNormalizada, ...(extrasGravados ? extras : {}) })
          .select()
          .single());
      }
      // Resiliência: se as colunas geo ainda não existirem, repete sem elas
      // (mesmo fallback do PATCH /api/teams/:slug).
      if (error && /geo_lat|geo_lng|cidade/i.test(error.message || '')) {
        extrasGravados = false;
        ({ data, error } = await supabase
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
          .single());
      }
      if (!error) team = data;
      else if (error.code === '23505') lastError = error; // slug duplicado -> tenta de novo
      else throw new HttpError(500, error.message);
    }
    if (!team) throw new HttpError(500, lastError?.message || 'Não foi possível criar o time.');

    // Adiciona o criador como admin (rollback se falhar). RODADA 29B (E): "Só organizo o time" (`joga: false` no corpo)
    // grava `team_members.joga = false` — ele administra tudo, mas fica fora da presença, do sorteio, do ranking e do
    // pacote. Sem a migração 067 a coluna não existe: o time nasce com o criador jogando (a resposta diz `joga: true`).
    const soOrganizo = req.body?.joga === false;
    let { error: memberError } = await supabase
      .from('team_members')
      .insert({ user_id: req.user.id, team_id: team.id, role: 'admin', ...(soOrganizo ? { joga: false } : {}) });
    let jogaGravado = soOrganizo;
    if (memberError && soOrganizo && /joga/i.test(memberError.message || '')) {
      jogaGravado = false;
      ({ error: memberError } = await supabase.from('team_members').insert({ user_id: req.user.id, team_id: team.id, role: 'admin' }));
    }
    if (memberError) {
      await supabase.from('teams').delete().eq('id', team.id);
      throw new HttpError(500, memberError.message);
    }
    selosCache.invalidarMembro(team.id, req.user.id);

    // `geo` (29B, D): o que a tela diz da cidade — { encontrada: true, nomeOficial } ou { encontrada: false }.
    // `bairro` (29H): o mesmo para o bairro — { encontrado, nomeOficial } ou { encontrado: false }; `salvo: false` quando a
    // migração 073 ainda não existe. `premios_salvos: false`: o pedido de desligar artilheiro/destaque não pôde ser gravado.
    const bairroResposta = bar.info ? (extrasGravados ? bar.info : { ...bar.info, salvo: false }) : null;
    const premiosPedidos = req.body?.mostrar_artilheiro === false || req.body?.mostrar_destaque === false;
    res.status(201).json({
      team,
      ...(cid.info ? { geo: cid.info } : {}),
      ...(bairroResposta ? { bairro: bairroResposta } : {}),
      ...(premiosPedidos && !extrasGravados ? { premios_salvos: false } : {}),
      joga: !jogaGravado,
    });
  })
);

/** GET /api/teams — lista as equipas de que o utilizador é membro. */
// Lógica em services/inicio.js#obterTeams — a MESMA função que GET /api/inicio
// usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterTeams(req.user.id));
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

    // geo_lat/geo_lng (arredondados) vão no payload → o cliente calcula a distância
    // LOCALMENTE (a posição do utilizador nunca chega ao servidor). Só equipas públicas.
    const COLUNAS = 'id, nome, slug, cor, localizacao, cidade, descricao, logo_url, cor_fundo, modo_visibilidade, geo_lat, geo_lng';
    const montar = (comNormalizada) => {
      let query = supabase
        .from('teams')
        .select(comNormalizada ? `${COLUNAS}, cidade_normalizada` : COLUNAS)
        .in('modo_visibilidade', ['publico_aprovacao', 'publico_aberto']);
      // q pesquisa em nome OU localização (a barra única diz "nome ou cidade").
      // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): q ia direto para dentro da
      // string de filtro do .or() — vírgula separa condições, parênteses
      // agrupam, ponto separa coluna.operador.valor no PostgREST; um q com esses
      // caracteres conseguia adicionar/alterar condições do filtro. O PostgREST
      // suporta valores com esses caracteres se o valor inteiro vier entre aspas
      // duplas — é o que valorFiltroOr faz quando encontra algum deles.
      if (q) {
        const padrao = valorFiltroOr(`%${q}%`);
        // RODADA 29B (D): time SEM coordenada (cidade que o Nominatim não achou) casa pelo texto da cidade,
        // normalizado — igual à busca normalizada. Com coordenada, quem manda é a distância (app).
        const porCidade = comNormalizada ? condicaoPorCidade(q, valorFiltroOr) : '';
        query = query.or(`nome.ilike.${padrao},localizacao.ilike.${padrao}${porCidade}`);
      }
      if (loc) query = query.ilike('localizacao', `%${loc}%`);
      return query;
    };

    let { data: teamsRaw, error } = await montar(true);
    // Migração 066 por aplicar: sem a coluna a busca continua como era.
    if (error && /cidade_normalizada/i.test(error.message || '')) ({ data: teamsRaw, error } = await montar(false));
    if (error) throw new HttpError(500, error.message);

    // Equipa suspensa = invisível na descoberta.
    const { equipas: susEquipas } = await plataforma.conjuntos();
    const teams = (teamsRaw || []).filter((t) => !susEquipas.has(t.id));

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
        cidade: t.cidade || null,
        cidade_normalizada: t.cidade_normalizada || null, // 29B (D): o app casa por texto quando não há ponto
        descricao: t.descricao,
        geo_lat: t.geo_lat ?? null, // arredondado ~1km; só entra na busca por distância se não-nulo
        geo_lng: t.geo_lng ?? null,
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
    const { data: teamsRaw, error } = await supabase
      .from('teams')
      .select('id, nome, slug, descricao, localizacao, logo_url, cor_fundo, modo_visibilidade')
      .in('modo_visibilidade', ['publico_aberto', 'publico_aprovacao']);
    if (error) throw new HttpError(500, error.message);

    // Equipa suspensa = invisível na descoberta.
    const { equipas: susEquipas } = await plataforma.conjuntos();
    const lista = (teamsRaw || []).filter((t) => !susEquipas.has(t.id));
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
    const COLUNAS = 'id, nome, slug, cor, criado_por, created_at, publica, mostrar_gols, localizacao, cidade, descricao, logo_url, cor_fundo, modo_visibilidade, geo_lat, geo_lng';
    // RODADA 29H: bairro e os dois prêmios do time (migração 073). Sem a migração a leitura com elas volta vazia (coluna
    // inexistente) e a página do time NÃO pode cair: repete só com as colunas de sempre.
    const team = (await getTeamBySlug(req.params.slug, `${COLUNAS}, bairro, mostrar_artilheiro, mostrar_destaque`))
      || (await getTeamBySlug(req.params.slug, COLUNAS));
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    // Achado 3/23: role e membros só dependem do team.id, não um do outro — em
    // paralelo em vez de dois round-trips seguidos ao Supabase.
    const [role, { data: rawMembers, error }, organizam] = await Promise.all([
      getRole(team.id, req.user.id),
      supabase
        .from('team_members')
        .select('role, created_at, categoria, users ( id, nome, nome_jogador, avatar_url, avatar_generico )')
        .eq('team_id', team.id)
        .order('created_at', { ascending: true }),
      idsQueSoOrganizam(team.id), // Rodada 29B (E): em consulta à parte (a coluna `joga` é da migração 067)
    ]);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    if (error) throw new HttpError(500, error.message);

    // E-mail não sai aqui: página pública do time, visível a qualquer membro.
    // Quem precisa de e-mail é o admin (Admin → Membros) ou o próprio (Perfil).
    const members = (rawMembers || []).map((m) => ({
      id: m.users?.id,
      nome: m.users?.nome,
      nome_jogador: m.users?.nome_jogador || null,
      avatar_url: m.users?.avatar_url,
      avatar_generico: m.users?.avatar_generico || null,
      role: m.role,
      joga: !organizam.has(m.users?.id), // 29B (E): false = só organiza o time
      // Rodada 10B: a FONTE é só categoria — a coluna `posicao` (Rodada 9) e a
      // `categoria` (que já mandava no ranking) eram a mesma decisão guardada
      // duas vezes; o dono escolheu ficar só com esta. `goleiro` é o campo novo
      // (booleano); `posicao` continua saindo por compatibilidade com o app já
      // instalado (Rodada 9) — os dois nunca podem discordar porque vêm da
      // MESMA leitura.
      goleiro: m.categoria === 'GR',
      posicao: m.categoria === 'GR' ? 'GL' : null,
      created_at: m.created_at,
    }));

    res.json({
      team: {
        ...team,
        // 29H: sem a migração 073 as colunas não vêm — valem os padrões (tudo ligado, sem bairro).
        bairro: team.bairro || null,
        mostrar_artilheiro: team.mostrar_artilheiro !== false,
        mostrar_destaque: team.mostrar_destaque !== false,
        role,
        joga: !organizam.has(req.user.id),
      },
      members,
    });
  })
);

/** PATCH /api/teams/:slug — edita a equipa (só admin). */
router.patch(
  '/api/teams/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar o time.');

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
    if ('mostrar_gols' in b) patch.mostrar_gols = !!b.mostrar_gols;
    // RODADA 29H (item 44): "Artilheiro do dia" e "Destaque do dia" — o editor de resultado só oferece a seção quando ligado.
    if ('mostrar_artilheiro' in b) patch.mostrar_artilheiro = !!b.mostrar_artilheiro;
    if ('mostrar_destaque' in b) patch.mostrar_destaque = !!b.mostrar_destaque;
    if ('localizacao' in b) patch.localizacao = b.localizacao ? String(b.localizacao).trim().slice(0, 100) : null;
    if ('descricao' in b) patch.descricao = b.descricao ? String(b.descricao).trim().slice(0, 300) : null;
    // GEO (opt-in): guarda o nome da CIDADE (texto) + o ponto ARREDONDADO (a morada exacta nunca entra). Limpar a
    // cidade tira a equipa da busca por distância. RODADA 29B (D), regra em utils/cidade.js: cidade DA LISTA → o ponto
    // vem da lista; fora dela → Nominatim; nada achou → guarda o texto e LIMPA o ponto (o de antes era de outra cidade;
    // sem ponto o Explorar casa por texto). Cidade igual à de antes (o painel reenvia o campo a cada "Salvar") não
    // geocodifica de novo nem mexe no ponto.
    let geoInfo = null;
    let cidResolvida = null; // o resultado da cidade quando ela foi (re)resolvida agora — o bairro, abaixo, parte dele
    if ('cidade' in b) {
      if (!String(b.cidade ?? '').trim()) {
        patch.cidade = null; patch.cidade_normalizada = null; patch.geo_lat = null; patch.geo_lng = null;
      } else {
        const { data: atual } = await supabase.from('teams').select('cidade').eq('id', team.id).maybeSingle();
        const igualDeAntes = !lerEscolhaDaLista(b) && !!atual?.cidade && normalizarCidade(atual.cidade) === normalizarCidade(b.cidade);
        if (igualDeAntes) {
          patch.cidade_normalizada = normalizarCidade(b.cidade); // só completa a coluna nova em time antigo
        } else {
          const cid = await resolverCidade(b);
          cidResolvida = cid;
          patch.cidade = cid.cidade;
          patch.cidade_normalizada = cid.normalizada;
          patch.geo_lat = cid.geo?.lat ?? null;
          patch.geo_lng = cid.geo?.lng ?? null;
          geoInfo = cid.info;
        }
      }
    }
    // RODADA 29H (item 12): o bairro. O ponto do time passa a ser o do bairro quando o motor o acha perto da cidade; sem
    // bairro (ou sem cidade onde pôr um) volta a ser o da cidade. O painel reenvia cidade e bairro a cada "Salvar": bairro
    // igual ao de antes, com a cidade igual, não geocodifica de novo nem mexe no ponto.
    let bairroInfo = null;
    if ('bairro' in b) {
      const novoBairro = lerBairro(b);
      const { data: atual, error: erroAtual } = await supabase
        .from('teams').select('cidade, geo_lat, geo_lng, bairro_normalizado').eq('id', team.id).maybeSingle();
      if (erroAtual && /bairro/i.test(erroAtual.message || '')) throw new HttpError(503, 'Essa opção ainda não está disponível.');
      const cidadeDoTime = 'cidade' in patch ? patch.cidade : (atual?.cidade ?? null);
      const normalizadoAntes = atual?.bairro_normalizado || '';
      const pontoDaCidade = async () => (cidResolvida || (await resolverCidade({ cidade: cidadeDoTime }))).geo;
      if (!novoBairro || !cidadeDoTime) {
        patch.bairro = null;
        patch.bairro_normalizado = null;
        if (normalizadoAntes && cidadeDoTime && !cidResolvida) {
          const g = await pontoDaCidade();
          patch.geo_lat = g?.lat ?? null;
          patch.geo_lng = g?.lng ?? null;
        }
      } else if (!(cidResolvida === null && normalizarCidade(novoBairro) === normalizadoAntes)) {
        const base = cidResolvida || { cidade: cidadeDoTime, geo: atual?.geo_lat != null ? { lat: atual.geo_lat, lng: atual.geo_lng } : null };
        const bar = await resolverBairro(b, base);
        patch.bairro = bar.bairro;
        patch.bairro_normalizado = bar.normalizado;
        if (bar.geo) {
          patch.geo_lat = bar.geo.lat;
          patch.geo_lng = bar.geo.lng;
        } else if (!cidResolvida) {
          const g = await pontoDaCidade();
          patch.geo_lat = g?.lat ?? null;
          patch.geo_lng = g?.lng ?? null;
        }
        bairroInfo = bar.info;
      }
    }
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

    let { data: updated, error } = await supabase.from('teams').update(patch).eq('id', team.id).select().single();
    // Migração 066 por aplicar: sem `cidade_normalizada` o texto e o ponto da cidade continuam a valer.
    if (error && /cidade_normalizada/i.test(error.message || '')) {
      const sem066 = { ...patch }; delete sem066.cidade_normalizada;
      ({ data: updated, error } = await supabase.from('teams').update(sem066).eq('id', team.id).select().single());
    }
    // Migração 073 por aplicar: o bairro e os prêmios do time ainda não têm onde ficar — o app diz, em vez de fingir.
    if (error && /bairro|mostrar_artilheiro|mostrar_destaque/i.test(error.message || '')) throw new HttpError(503, 'Essa opção ainda não está disponível.');
    // Resiliência: se as colunas geo ainda não existirem (DDL 041 por correr), repete sem elas.
    if (error && /geo_lat|geo_lng|cidade/i.test(error.message || '')) {
      const semGeo = { ...patch }; delete semGeo.geo_lat; delete semGeo.geo_lng; delete semGeo.cidade; delete semGeo.cidade_normalizada;
      ({ data: updated, error } = await supabase.from('teams').update(semGeo).eq('id', team.id).select().single());
    }
    if (error) throw new HttpError(500, error.message);
    res.json({ team: updated, ...(geoInfo ? { geo: geoInfo } : {}), ...(bairroInfo ? { bairro: bairroInfo } : {}) });
  })
);

/**
 * PUT /api/teams/:slug/brilhante-kit { kitId } — Pagamentos P2: o dono escolhe o uniforme das
 * figurinhas do time (o pacote comprado na loja chega sem uniforme). Só admin, só com o pacote
 * ativo; trocar só antes da primeira geração. Regras em utils/uniformeDoPacote.js.
 */
router.put(
  '/api/teams/:slug/brilhante-kit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    // eslint-disable-next-line global-require
    const { KITS_IA } = require('./auth');
    const kitsValidos = Object.entries(KITS_IA || {}).filter(([, k]) => k?.ativo).map(([id]) => id);
    const r = await escolherUniforme({ teamId: team.id, userId: req.user.id, kitId: String(req.body?.kitId || ''), kitsValidos });
    res.json({ ok: true, ...r });
  })
);

/**
 * POST /api/teams/:slug/logo — carrega o logo da equipa (só admin; PNG/JPG/WEBP, máx 2MB).
 * LEIS DA SEGURANÇA: filtro NSFW (explícito → 403) ANTES de guardar; ficheiro no bucket
 * PRIVADO "avatars" (path logos/{teamId}); o URL é assinado/proxied na fronteira da API
 * (middleware mediaUrls), como os avatares. EscudoEquipa/TeamAvatar já mostram o logo_url.
 */
router.post(
  '/api/teams/:slug/logo',
  requireAuth,
  logoMiddleware,
  // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): antes só checava o
  // mimetype declarado pelo multer; agora confirma que decodifica como
  // imagem de verdade (mesmo princípio do avatar, utils/olheiroEntrada.js).
  verificarImagemReal,
  // Fail-CLOSED aqui (diferente do avatar): o logo é visível a qualquer
  // visitante do time sem sessão, então um erro técnico na análise bloqueia
  // em vez de deixar passar.
  filtroNSFWFailClosed,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem mudar o logo.');

    if (!req.file) throw new HttpError(400, 'Envie uma imagem PNG, JPG ou WEBP (máx 2MB).');
    const ext = LOGO_EXT[req.file.mimetype];

    const caminho = `logos/${team.id}.${ext}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, req.file.buffer, {
      contentType: req.file.mimetype, upsert: true, cacheControl: '3600',
    });
    if (upErr) throw new HttpError(500, upErr.message);
    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const logoUrl = `${pub.publicUrl}?v=${Date.now()}`; // ?v= força recarga (path fixo)

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
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os membros em detalhe.');

    // Achado 3/23: estas 4 leituras só dependem de team.id, nenhuma do resultado
    // das outras — corriam em série. Em paralelo; só a busca de presenças (que
    // precisa dos IDs dos "últimos jogos") fica sequencial a seguir.
    const [{ data, error }, { data: votos }, { data: ultimosJogos }, agregados, organizam] = await Promise.all([
      supabase
        .from('team_members')
        .select('id, role, pode_postar, categoria, visivel_ranking, nota_interna, ausente_proximo, ativo, gols, artilharia, vitorias, destaque, users ( id, nome, nome_jogador, avatar_url, avatar_generico, email )')
        .eq('team_id', team.id),
      // Nota média exibida (1-10): média dos votos recebidos na equipa, com o
      // mesmo cálculo do ranking. Requer >= 3 votos, senão fica null.
      supabase.from('votes').select('para_user_id, nota').eq('team_id', team.id),
      // Últimos 5 jogos da equipa (mais recente → mais antigo) para o histórico
      // de presenças. Um jogador esteve presente se tem game_players.confirmado.
      supabase.from('games').select('id, data, created_at').eq('team_id', team.id).order('created_at', { ascending: false }).limit(5),
      // Agregados VIVOS (mesma fonte/critério do ranking — uma só verdade).
      agregadosDaEquipa(team.id),
      idsQueSoOrganizam(team.id), // Rodada 29B (E)
    ]);
    if (error) throw new HttpError(500, error.message);
    const { golsMap, vitoriasMap, artilhariaMap, destaquesMap } = agregados;

    const MIN_VOTOS = 3;
    const votosAgg = {}; // user_id -> { sum, count }
    for (const v of votos || []) {
      const a = (votosAgg[v.para_user_id] = votosAgg[v.para_user_id] || { sum: 0, count: 0 });
      a.sum += Number(v.nota);
      a.count += 1;
    }

    const jogos = ultimosJogos || [];
    const presentesPorJogo = {}; // game_id -> Set(user_id confirmados)
    if (jogos.length) {
      const { data: gps } = await supabase
        .from('game_players')
        .select('game_id, user_id, confirmado')
        .in('game_id', jogos.map((g) => g.id))
        .eq('confirmado', true);
      for (const gp of gps || []) {
        (presentesPorJogo[gp.game_id] = presentesPorJogo[gp.game_id] || new Set()).add(gp.user_id);
      }
    }

    const membros = (data || []).map((m) => {
      const uid = m.users?.id;
      const presencas = jogos.map((g) => ({
        game_id: g.id,
        data: g.data,
        presente: !!presentesPorJogo[g.id]?.has(uid),
      }));
      const presentes = presencas.filter((p) => p.presente).length;
      const va = votosAgg[uid];
      const notaMedia = va && va.count >= MIN_VOTOS ? notaParaExibir(va.sum / va.count) : null;
      return {
        id: m.id,
        user_id: uid,
        role: m.role,
        pode_postar: !!m.pode_postar,
        categoria: m.categoria || 'linha',
        // Rodada 10B: uma só flag — categoria manda. `goleiro` é o campo novo;
        // `posicao` sai calculado dela, só por compatibilidade com o app já
        // instalado (nunca mais é lido da coluna `posicao`).
        goleiro: m.categoria === 'GR',
        posicao: m.categoria === 'GR' ? 'GL' : null,
        ausente_proximo: !!m.ausente_proximo,
        ativo: m.ativo !== false,
        joga: !organizam.has(uid), // 29B (E): false = só organiza o time
        visivel_ranking: m.visivel_ranking !== false,
        nota_interna: m.nota_interna || null,
        nome: m.users?.nome || null,
        nome_jogador: m.users?.nome_jogador || null,
        avatar_url: m.users?.avatar_url || null,
        avatar_generico: m.users?.avatar_generico || null,
        email: m.users?.email || null,
        gols: golsMap[uid] || 0,
        artilharia: artilhariaMap[uid] || 0,
        vitorias: vitoriasMap[uid] || 0,
        destaque: destaquesMap[uid] || 0,
        presencas_recentes: presencas,
        taxa_presenca: presencas.length ? `${presentes}/${presencas.length}` : null,
        nota_media: notaMedia,
        // 22-set (SPEC-FIGURINHA-3): `plan` deixou de significar algo pago —
        // o selo do admin agora é ter a Brilhante: o avatar ser uma figurinha NOSSA
        // (utils/figurinhaRegra.js, a regra única; a desigualdade avatar_url ≠ foto_url
        // que valia até o Hotfix 26 contava a foto do Google como figurinha).
        tem_brilhante: avatarEhFigurinhaNossa(m.users?.avatar_url),
      };
    });
    membros.sort((a, b) => {
      if ((a.role === 'admin') !== (b.role === 'admin')) return a.role === 'admin' ? -1 : 1;
      return String(a.nome_jogador || a.nome || '').localeCompare(String(b.nome_jogador || b.nome || ''), 'pt', { sensitivity: 'base' });
    });
    res.json({ membros });
  })
);

/**
 * PATCH /api/equipas/:slug/membros/posicao — marca (ou desmarca) o jogador como
 * goleiro do time. Qualquer membro define a sua; admin pode definir a de outro
 * (body.user_id). Body: { goleiro: true|false } (ou, por compatibilidade com o
 * app já instalado antes da Rodada 10B: { posicao: 'GL'|null }).
 *
 * Rodada 9 (decisão do dono, 16-set): só existe goleiro ou jogador de linha.
 * Rodada 10B (16-set): esta rota GRAVA `categoria` (não mais `posicao`) — era a
 * mesma decisão em duas colunas (esta e a que já mandava no ranking); o dono
 * escolheu ficar só com `categoria`. A rota/campo antigo do admin
 * (PATCH /api/teams/:slug/membros/:userId com `categoria`) continua igual e
 * grava a mesma coluna — as duas nunca mais podem discordar.
 */
router.patch(
  '/api/equipas/:slug/membros/posicao',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    // `goleiro` manda quando presente; senão cai no contrato antigo (posicao
    // 'GL'|null) — qualquer valor que não seja 'GL' (inclusive os extintos
    // DEF/MEI/ATA) vira "não é goleiro", como já era.
    const ligado = 'goleiro' in b ? !!b.goleiro : b.posicao === 'GL';
    const alvoId = b.user_id;

    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    const targetUserId = alvoId || req.user.id;
    if (targetUserId !== req.user.id && role !== 'admin') {
      throw new HttpError(403, 'Só admins podem alterar a posição de outros membros.');
    }

    const { error } = await supabase
      .from('team_members')
      .update({ categoria: ligado ? 'GR' : 'linha' })
      .eq('team_id', team.id)
      .eq('user_id', targetUserId);
    if (error) throw new HttpError(500, error.message);
    selosCache.invalidarMembro(team.id, targetUserId); // categoria mexe no ranking

    res.json({ ok: true, goleiro: ligado, posicao: ligado ? 'GL' : null });
  })
);

/**
 * PATCH /api/equipas/:slug/membros/joga — "Eu jogo" / "Só organizo o time" (Rodada 29B, E; migração 067). A pessoa muda o
 * SEU papel (nunca o de outra). Só quem administra o time pode ficar só organizando (`joga: false`); voltar a jogar é de
 * qualquer um. Quem só organiza administra tudo, mas não entra na presença, no sorteio, no ranking nem no pacote.
 * Body: { joga: true|false }.
 */
router.patch(
  '/api/equipas/:slug/membros/joga',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (typeof req.body?.joga !== 'boolean') throw new HttpError(400, 'Diga se você joga (joga: true ou false).');
    const joga = req.body.joga;
    if (!joga && role !== 'admin') throw new HttpError(403, 'Só quem administra o time pode ficar só organizando.');
    const { error } = await supabase.from('team_members').update({ joga }).eq('team_id', team.id).eq('user_id', req.user.id);
    if (error) {
      if (/joga/i.test(error.message || '')) throw new HttpError(503, 'Essa opção ainda não está disponível. Tente de novo mais tarde.');
      throw new HttpError(500, error.message);
    }
    selosCache.invalidarEquipa(team.id); // presença, sorteio e ranking mudam de quem entra
    res.json({ ok: true, joga });
  })
);

/**
 * PATCH /api/teams/:slug/membros/ausencia — o próprio jogador declara (ou
 * reverte) que não vai ao próximo jogo. Body: { ausente: true|false }.
 * Registado ANTES de /membros/:userId para o "ausencia" não cair no :userId.
 */
router.patch(
  '/api/teams/:slug/membros/ausencia',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);
    const ausente = !!(req.body || {}).ausente;
    const { error } = await supabase
      .from('team_members')
      .update({ ausente_proximo: ausente })
      .eq('team_id', team.id)
      .eq('user_id', req.user.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true, ausente });
  })
);

/**
 * PATCH /api/teams/:slug/membros/:userId/ativo — admin marca um jogador como
 * activo/inactivo. Inactivos ficam no histórico mas saem do sorteio e ranking.
 * Body: { ativo: true|false }.
 */
router.patch(
  '/api/teams/:slug/membros/:userId/ativo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem marcar jogadores como inativos.');

    const ativo = !!(req.body || {}).ativo;
    const { error } = await supabase
      .from('team_members')
      .update({ ativo })
      .eq('team_id', team.id)
      .eq('user_id', req.params.userId);
    if (error) throw new HttpError(500, error.message);
    selosCache.invalidarEquipa(team.id); // inativo sai do ranking
    res.json({ ok: true, ativo });
  })
);

/** DELETE /api/teams/:slug/membros/:userId — remove um membro (só admin). */
router.delete(
  '/api/teams/:slug/membros/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem remover membros.');
    if (req.params.userId === req.user.id) throw new HttpError(400, 'Você não pode remover a si mesmo.');

    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', team.id)
      .eq('user_id', req.params.userId);
    if (error) throw new HttpError(500, error.message);
    selosCache.invalidarMembro(team.id, req.params.userId);
    res.json({ removed: true });
  })
);

/**
 * DELETE /api/teams/:slug/membros/me — SAIR da equipa pelo próprio (SPEC-EQUIPAS).
 * História preservada (mesmo efeito da remoção pelo admin: o passado fica; sai do
 * ranking e do futuro). Guardas: último admin não sai sem passar o cargo; sozinho
 * na equipa → arquivar é vaga futura (recusa com mensagem clara).
 */
router.delete(
  '/api/teams/:slug/membros/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(400, 'Você não é membro deste time.');

    const { data: membros, error: em } = await supabase
      .from('team_members')
      .select('user_id, role')
      .eq('team_id', team.id);
    if (em) throw new HttpError(500, em.message);

    if ((membros || []).length === 1) {
      throw new HttpError(400, 'Você é a única pessoa no time. Para arquivar o time, fale com a gente.');
    }
    if (role === 'admin') {
      const outrosAdmins = (membros || []).filter((m) => m.role === 'admin' && m.user_id !== req.user.id);
      if (outrosAdmins.length === 0) {
        throw new HttpError(400, 'Você é o único admin: passe o cargo a outro membro antes de sair.');
      }
    }

    const { error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', team.id)
      .eq('user_id', req.user.id);
    if (error) throw new HttpError(500, error.message);
    selosCache.invalidarMembro(team.id, req.user.id);
    res.json({ saiu: true });
  })
);

/** PATCH /api/teams/:slug/membros/:userId — muda role/pode_postar (só admin). */
router.patch(
  '/api/teams/:slug/membros/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar membros.');

    const b = req.body || {};
    const patch = {};
    if ('role' in b) {
      if (!['admin', 'member'].includes(b.role)) throw new HttpError(400, 'role inválido.');
      if (req.params.userId === req.user.id) throw new HttpError(400, 'Você não pode mudar o seu próprio role.');
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
    selosCache.invalidarEquipa(team.id); // categoria e visivel_ranking mexem no ranking
    res.json({ membro: updated });
  })
);

/** POST /api/teams/:slug/convite — gera um token de convite (qualquer membro) e, junto, o código do link curto /c/<código> (29H). */
router.post(
  '/api/teams/:slug/convite',
  requireAuth,
  conviteLimiter,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CONVITE_DIAS * 86400000).toISOString();

    const { data: convite, error } = await supabase
      .from('convites')
      .insert({ team_id: team.id, token, criado_por: req.user.id, expires_at: expiresAt })
      .select('id, token, expires_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    // Rodada 29H (item 7): o link curto. `codigo` é null quando a migração 072 ainda não foi aplicada — o convite vale pelo
    // link longo, como sempre.
    const codigo = await criarCodigo(supabase, convite.id);

    res.status(201).json({ token: convite.token, codigo, expires_at: convite.expires_at });
  })
);

/**
 * GET /api/convite/:token — valida um convite (público; auth opcional). O parâmetro é o token longo (uuid) OU o código
 * curto de /c/<código> (29H). Devolve sempre 200 com { valido, motivo, ... }.
 */
router.get(
  '/api/convite/:token',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const convite = await convitePorParametro(supabase, req.params.token, 'id, team_id, criado_por, expires_at');

    if (!convite) {
      return res.json({ valido: false, motivo: 'nao_encontrado', team: null });
    }

    // RODADA 29A (item 11, "o link demora a abrir"): o time, quem convidou, os usos e o papel de quem abre só
    // dependem do CONVITE, que já foi lido — iam em fila, uma ida a São Paulo atrás da outra (de Lisboa, ~300 ms
    // cada). Agora saem juntos: 2 idas no total (o convite, depois estas ao mesmo tempo). O select do
    // time leva também logo_url e cor_fundo, para a página do convite mostrar o escudo de verdade.
    // RODADA 29B (A): a página nova mostra 3 fatos para dar vontade de entrar — quantos já estão no time, quando é o
    // próximo jogo e de que cidade. Entram na MESMA leva (a cidade vem no select do time; a contagem e o próximo
    // jogo são duas consultas a mais, em paralelo): continuam 2 idas no total.
    const [{ data: team }, { data: inviter }, { data: usosRows }, role, { count: membrosTotal }, { data: proximo }, organizam] = await Promise.all([
      supabase
        .from('teams')
        .select('id, nome, slug, cor, logo_url, cor_fundo, cidade')
        .eq('id', convite.team_id)
        .single(),
      supabase
        .from('users')
        .select('nome, nome_jogador')
        .eq('id', convite.criado_por)
        .maybeSingle(),
      // RODADA 20 — 'usado' deixou de existir: o link é reutilizável, só 'expirado' (ou 'nao_encontrado',
      // acima) barra. `usos` é best-effort (migração 058); sem ela, 0 — nunca derruba a validação do convite.
      supabase.from('convite_usos').select('user_id').eq('convite_id', convite.id),
      req.user ? getRole(convite.team_id, req.user.id) : null,
      supabase.from('team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', convite.team_id),
      // Próximo jogo = o primeiro ainda agendado daqui pra frente (cancelado/terminado não contam). Só a DATA sai
      // daqui: o local do jogo nunca vai para quem só tem o link.
      supabase
        .from('games')
        .select('data')
        .eq('team_id', convite.team_id)
        .eq('status', 'agendado')
        .gte('data', new Date().toISOString())
        .order('data', { ascending: true })
        .limit(1)
        .maybeSingle(),
      idsQueSoOrganizam(convite.team_id), // 29B (E): o fato é "N jogadores" — quem só organiza não conta
    ]);

    const motivo = new Date(convite.expires_at).getTime() < Date.now() ? 'expirado' : null;
    const usos = (usosRows || []).length;
    const jaMembro = !!(req.user && team && role);

    res.json({
      valido: motivo === null,
      motivo,
      autenticado: !!req.user,
      jaMembro,
      convidadoPor: inviter?.nome_jogador || inviter?.nome || null,
      expires_at: convite.expires_at,
      usos,
      // Os fatos da página (29B, A): `membros` é a contagem, `proximoJogo` o instante do próximo jogo agendado
      // (ISO; o app o escreve como data curta no fuso de quem olha) ou null, `cidade` o texto que o admin declarou.
      membros: Math.max(0, (membrosTotal ?? 0) - organizam.size),
      proximoJogo: proximo?.data || null,
      cidade: team?.cidade || null,
      team: team ? { nome: team.nome, slug: team.slug, cor: team.cor, logo_url: team.logo_url || null, cor_fundo: team.cor_fundo || null } : null,
    });
  })
);

/** POST /api/convite/:token/aceitar — entra na equipa e consome o convite. `:token` é o uuid ou o código curto (29H). */
router.post(
  '/api/convite/:token/aceitar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const convite = await convitePorParametro(supabase, req.params.token, 'id, team_id, expires_at');
    if (!convite) throw new HttpError(404, 'Convite não encontrado.');

    const { data: team } = await supabase
      .from('teams')
      .select('id, slug, nome, cor')
      .eq('id', convite.team_id)
      .single();
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    await ensureUserRow(req.user);

    // `id` (29H): o Onboarding marca as boas-vindas do time como vistas (`futty_onboarding_<id>`) logo que a pessoa entra.
    const teamResumo = { id: team.id, slug: team.slug, nome: team.nome, cor: team.cor };

    // Já é membro? -> idempotente, não consome o convite
    const existingRole = await getRole(team.id, req.user.id);
    if (existingRole) {
      return res.json({ jaMembro: true, team: teamResumo });
    }

    // Valida o estado do convite (apenas para novos membros). RODADA 20 — o
    // link é reutilizável: só a validade importa, não se já foi usado antes.
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
    selosCache.invalidarMembro(team.id, req.user.id);

    // RODADA 20 — regista o uso em vez de marcar o convite como consumido
    // (migração 058): o link continua válido para a próxima pessoa. Fail-safe
    // de propósito: tabela ausente ou 23505 (mesma pessoa aceitando de novo,
    // corrida) nunca podem derrubar uma entrada que já valeu (o INSERT em
    // team_members acima já commitou).
    const { error: usoError } = await supabase.from('convite_usos').insert({ convite_id: convite.id, user_id: req.user.id });
    if (usoError && usoError.code !== '23505') {
      console.warn('[convite] convite_usos indisponível (migração 058 aplicada?):', usoError.message);
    }

    res.status(201).json({ jaMembro: false, team: teamResumo });
  })
);

/** POST /api/teams/:slug/pedir-entrada — pedir entrada numa equipa pública. */
router.post(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, modo_visibilidade');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    if (team.modo_visibilidade === 'privado') throw new HttpError(403, 'Este time não é público.');

    const role = await getRole(team.id, req.user.id);
    if (role) throw new HttpError(400, 'Você já é membro deste time.');

    await ensureUserRow(req.user);

    // Equipa aberta: entra já como membro, sem pedido pendente.
    if (team.modo_visibilidade === 'publico_aberto') {
      const { error: me } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, user_id: req.user.id, role: 'member' }, { onConflict: 'user_id,team_id' });
      if (me) throw new HttpError(500, me.message);
      selosCache.invalidarMembro(team.id, req.user.id);
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

/** DELETE /api/teams/:slug/pedir-entrada — cancela o MEU pedido pendente. */
router.delete(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const { error } = await supabase
      .from('team_join_requests')
      .delete()
      .eq('team_id', team.id)
      .eq('user_id', req.user.id)
      .eq('status', 'pending');
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/**
 * GET /api/me/pedidos — os MEUS pedidos de entrada visíveis no app (ciclo v1,
 * sem push): desfechos (approved/rejected ainda não dispensados) E os que ainda
 * estão PENDING (P1-4 — o candidato via o pendente só no Explorar). O Início
 * separa: pending → card "pedido pendente · cancelar"; resto → desfecho.
 */
router.get(
  '/api/me/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterPedidos(req.user.id));
  })
);

/** DELETE /api/me/pedidos/:id — dispensa o desfecho (apaga a MINHA linha). */
router.delete(
  '/api/me/pedidos/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('team_join_requests')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .in('status', ['approved', 'rejected']);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/** GET /api/teams/:slug/pedidos — pedidos pendentes (só admin). */
router.get(
  '/api/teams/:slug/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

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

    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

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
      selosCache.invalidarMembro(team.id, pedido.user_id);
    }

    const { data: updated, error } = await supabase
      .from('team_join_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pedido.id)
      .select('id, status, updated_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    // Rodada 29D: quem foi aceito recebe o push e abre o time já com as boas-vindas (`?entrou=1` → Equipa.jsx). Só na 1ª
    // aprovação (um 2º toque do admin não avisa de novo), com o aceite já gravado e ANTES de responder (no Cloud Run a CPU
    // fica estrangulada depois da resposta). O push nunca derruba o aceite — falha vira log — e não segura o admin: espera
    // no máximo 4 s.
    if (status === 'approved' && pedido.status !== 'approved') {
      let teto;
      try {
        await Promise.race([
          Promise.resolve(enviarNotificacao([pedido.user_id], {
            title: `Você entrou no time ${team.nome}!`,
            body: 'Confirme presença e veja o próximo jogo.',
            url: `/equipa/${team.slug}?entrou=1`,
          })),
          new Promise((resolve) => { teto = setTimeout(resolve, 4000); }),
        ]);
      } catch (e) {
        console.warn('[teams] push do aceite de pedido falhou (o aceite foi gravado):', e?.message || e);
      } finally {
        clearTimeout(teto);
      }
    }

    res.json({ pedido: updated });
  })
);

/** GET /api/teams/:slug/convites — convites activos (não usados, não expirados). */
router.get(
  '/api/teams/:slug/convites',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os convites.');

    // RODADA 20 — sem o .is('usado_por', null): o link reutilizável continua
    // "ativo" mesmo depois de usado; só a validade (expires_at) tira da lista.
    const nowIso = new Date().toISOString();
    const { data: convites, error } = await supabase
      .from('convites')
      .select('id, token, created_at, expires_at, criado_por')
      .eq('team_id', team.id)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    // Nomes dos criadores (criado_por).
    const ids = [...new Set((convites || []).map((c) => c.criado_por).filter(Boolean))];
    const nomeMap = {};
    if (ids.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador').in('id', ids);
      for (const u of us || []) nomeMap[u.id] = u.nome_jogador || u.nome || 'Jogador';
    }

    // "N entraram por este link" — uma query só (in convite_id), contada em
    // memória. Best-effort (migração 058): sem ela, todos ficam em 0.
    const conviteIds = (convites || []).map((c) => c.id);
    const usosMap = {};
    if (conviteIds.length) {
      const { data: usos } = await supabase.from('convite_usos').select('convite_id').in('convite_id', conviteIds);
      for (const u of usos || []) usosMap[u.convite_id] = (usosMap[u.convite_id] || 0) + 1;
    }

    // O código do link curto (29H, migração 072): best-effort — sem a tabela, o admin segue com o link longo.
    const codigosMap = await codigosDosConvites(supabase, conviteIds);

    const lista = (convites || []).map((c) => ({
      id: c.id,
      token: c.token,
      codigo: codigosMap[c.id] || null,
      criado_por_nome: c.criado_por ? nomeMap[c.criado_por] || null : null,
      created_at: c.created_at,
      expires_at: c.expires_at,
      usos: usosMap[c.id] || 0,
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
    if (!team) throw new HttpError(404, 'Time não encontrado.');
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
    if (!team) throw new HttpError(404, 'Time não encontrado.');
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
