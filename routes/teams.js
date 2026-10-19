// Futty v2.0 — Rotas do time: criar, listar, detalhe, editar, uniforme do pacote, logo e estatísticas. Explorar, membros e
// convites vivem em sub-roteadores (explorarTimes, membrosDoTime, convitesDoTime) montados aqui, cada um no lugar de onde saiu.
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow } = require('../utils/db');
const { obterTeams } = require('../services/inicio');
const { filtroNSFWFailClosed } = require('../utils/nsfwFilter');
const { verificarImagemReal } = require('../utils/imagemReal');
const { resolverCidade, lerEscolhaDaLista, normalizarCidade, lerBairro, resolverBairro } = require('../utils/cidade');
const { slugify } = require('../utils/helpers');
const selosCache = require('../utils/selosCache');
const { escolherUniforme } = require('../utils/uniformeDoPacote');
const { idsQueSoOrganizam } = require('../utils/soOrganiza');
const { idsDosJogosQueAconteceram } = require('../utils/jogoAconteceu'); // presença só conta depois do horário do jogo
const { MSG_ARTILHEIRO_PRECISA_DOS_GOLS, combinacaoDePremiosCoerente } = require('../utils/premiosDoTime'); // o artilheiro depende dos gols
const { FUSO_PADRAO, fusoDoTime, fusoDaCoordenada, horaNoFuso, erroDaColunaFuso } = require('../utils/fuso'); // o fuso do time
const { PALETA, CORES_ANTIGAS, lerEscudo, erroDeEscudoSemMigracao, escudoDoTime } = require('../utils/escudo'); // o escudo do time
const { lerJogadoresPorTime, jogadoresPorTimeDoTime, erroDaColunaJogadoresPorTime } = require('../utils/jogadoresPorTime');
const { textoCurto } = require('../utils/entrada');

const router = express.Router();

/**
 * No time recém-criado, grava o fuso derivado do ponto da cidade geocodificada. Melhor esforço: sem ponto,
 * sem fuso derivável ou sem a migração 076, não grava nada e o time fica no padrão (America/Sao_Paulo, o
 * que a coluna nasce valendo — por isso o padrão nem precisa de escrita). Devolve o fuso que o time
 * passou a ter.
 */
async function gravarFusoDoTimeNovo(team, geo) {
  const derivado = fusoDaCoordenada(geo?.lat, geo?.lng);
  if (!derivado || derivado === FUSO_PADRAO) return fusoDoTime(team);
  const { error } = await supabase.from('teams').update({ fuso: derivado }).eq('id', team.id);
  if (error) {
    if (!erroDaColunaFuso(error)) console.error('[teams] não deu para gravar o fuso do time:', error.message);
    return fusoDoTime(team);
  }
  return derivado;
}

// A cor principal do escudo vem da paleta de 12 (utils/escudo.js); as 4 chaves antigas continuam valendo.
const CORES_VALIDAS = [...new Set([...PALETA, ...CORES_ANTIGAS])];
const MODOS_VISIBILIDADE = ['privado', 'publico_aprovacao', 'publico_aberto'];

// Upload do logo do time (em memória; gravado no bucket privado "avatars").
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

/** POST /api/teams — cria um time e adiciona o criador como admin. */
router.post(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { cor, publica, localizacao, descricao } = req.body || {};
    // Mesmo teto do PATCH /api/teams/:slug (60): o app limita a 40, mas o corpo aceita qualquer coisa — e o nome vai para o slug e para todo o time.
    const nomeDoTime = textoCurto(req.body?.nome, 60, 'Nome');
    if (!nomeDoTime) throw new HttpError(400, 'O nome do time é obrigatório.');
    const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';
    const localizacaoFinal = localizacao ? String(localizacao).trim().slice(0, 100) : null;
    const descricaoFinal = descricao ? String(descricao).trim().slice(0, 300) : null;
    // O artilheiro depende dos gols — gols desligados com artilheiro ligado é combinação incoerente e o
    // motor recusa. `mostrar_gols` vem também no POST, para o time nascer já com os dois prêmios coerentes.
    const golsLigados = req.body?.mostrar_gols !== false;
    if (!combinacaoDePremiosCoerente({ mostrar_gols: req.body?.mostrar_gols, mostrar_artilheiro: req.body?.mostrar_artilheiro })) {
      throw new HttpError(400, MSG_ARTILHEIRO_PRECISA_DOS_GOLS);
    }

    // GEO: guarda o nome da CIDADE (texto) + o ponto ARREDONDADO (a morada exacta nunca entra), mesma regra do
    // PATCH /api/teams/:slug. Regra completa em utils/cidade.js: cidade DA LISTA do app → a coordenada vem
    // da lista (sem Nominatim); fora dela → Nominatim; se nada achar, guarda só o texto (normalizado em
    // `cidade_normalizada`, para o Explorar casar por texto) e segue — nunca bloqueia a criação do time.
    const cid = await resolverCidade(req.body || {});
    const cidadeFinal = cid.cidade;
    // O bairro opcional. Achou perto da cidade → o ponto do time é o do bairro; senão fica o da cidade.
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

    // Cria o time (com retry se o slug colidir)
    let team = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !team; attempt += 1) {
      const slug = slugify(nomeDoTime);
      const linhaDoTime = {
        nome: nomeDoTime,
        slug,
        cor: corFinal,
        criado_por: req.user.id,
        publica: !!publica,
        localizacao: localizacaoFinal,
        descricao: descricaoFinal,
        ...(golsLigados ? {} : { mostrar_gols: false }),
      };
      const colunasDaCidade = { cidade: cidadeFinal, cidade_normalizada: cid.normalizada, geo_lat: geoLat, geo_lng: geoLng };
      let { data, error } = await supabase
        .from('teams')
        .insert({ ...linhaDoTime, ...colunasDaCidade, ...extras })
        .select()
        .single();
      // Migração 077 por aplicar: a regra antiga do banco só aceita 4 cores — o time nasce com a de sempre (roxo) e o admin troca depois.
      if (error && /teams_cor_check/i.test(error.message || '')) {
        linhaDoTime.cor = 'verde';
        ({ data, error } = await supabase.from('teams').insert({ ...linhaDoTime, ...colunasDaCidade, ...extras }).select().single());
      }
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
            nome: nomeDoTime,
            slug,
            cor: linhaDoTime.cor,
            criado_por: req.user.id,
            publica: !!publica,
            localizacao: localizacaoFinal,
            descricao: descricaoFinal,
            ...(golsLigados ? {} : { mostrar_gols: false }),
          })
          .select()
          .single());
      }
      if (!error) team = data;
      else if (error.code === '23505') lastError = error; // slug duplicado -> tenta de novo
      else throw new HttpError(500, error.message);
    }
    if (!team) throw new HttpError(500, lastError?.message || 'Não foi possível criar o time.');

    // Adiciona o criador como admin (rollback se falhar). "Só organizo o time" (`joga: false` no corpo)
    // grava `team_members.joga = false` — ele administra tudo, mas fica fora da presença, do sorteio,
    // do ranking e do pacote. Sem a migração 067 a coluna não existe: o time nasce com o criador jogando
    // (a resposta diz `joga: true`).
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

    // O fuso nasce da cidade geocodificada (da lista do app ou do Nominatim); sem cidade ou sem ponto,
    // o padrão.
    team.fuso = await gravarFusoDoTimeNovo(team, cid.geo);

    // `geo`: o que a tela diz da cidade — { encontrada: true, nomeOficial } ou { encontrada: false }.
    // `bairro`: o mesmo para o bairro — { encontrado, nomeOficial } ou { encontrado: false }; `salvo: false`
    // quando a migração 073 ainda não existe. `premios_salvos: false`: o pedido de desligar
    // artilheiro/destaque não pôde ser gravado.
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

/** GET /api/teams — lista os times de que o usuário é membro. */
// Lógica em services/inicio.js#obterTeams — a MESMA função que GET /api/inicio
// usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterTeams(req.user.id));
  })
);

// Explorar e a vitrine dos públicos (routes/explorarTimes.js): ANTES de /api/teams/:slug, para não colidir com o param :slug.
router.use(require('./explorarTimes'));

/** GET /api/teams/:slug — detalhes do time + lista de membros (só membros). */
router.get(
  '/api/teams/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const COLUNAS = 'id, nome, slug, cor, criado_por, created_at, publica, mostrar_gols, localizacao, cidade, descricao, logo_url, cor_fundo, modo_visibilidade, geo_lat, geo_lng';
    // Bairro e os dois prêmios do time (migração 073). Sem a migração a leitura com elas volta vazia (coluna
    // inexistente) e a página do time NÃO pode cair: repete só com as colunas de sempre.
    const team = (await getTeamBySlug(req.params.slug, `${COLUNAS}, bairro, mostrar_artilheiro, mostrar_destaque`))
      || (await getTeamBySlug(req.params.slug, COLUNAS));
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    // Role e membros só dependem do team.id, não um do outro — em
    // paralelo em vez de dois round-trips seguidos ao Supabase.
    const [role, { data: rawMembers, error }, organizam] = await Promise.all([
      getRole(team.id, req.user.id),
      supabase
        .from('team_members')
        .select('role, created_at, categoria, users ( id, nome, nome_jogador, avatar_url, avatar_generico )')
        .eq('team_id', team.id)
        .order('created_at', { ascending: true }),
      idsQueSoOrganizam(team.id), // em consulta à parte (a coluna `joga` é da migração 067)
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
      joga: !organizam.has(m.users?.id), // false = só organiza o time
      // A FONTE é só categoria — a coluna `posicao` e a `categoria` (que já mandava no ranking) eram a mesma
      // decisão guardada duas vezes; o dono escolheu ficar só com esta. `goleiro` é o campo (booleano);
      // `posicao` continua saindo por compatibilidade com o app já instalado — os dois nunca podem discordar
      // porque vêm da MESMA leitura.
      goleiro: m.categoria === 'GR',
      posicao: m.categoria === 'GR' ? 'GL' : null,
      created_at: m.created_at,
    }));

    res.json({
      team: {
        ...team,
        fuso: fusoDoTime(team), // sem a migração 076 a coluna não vem — vale o padrão
        ...escudoDoTime(team), // sem a 077 o escudo vale sólido, uma cor
        jogadores_por_time: jogadoresPorTimeDoTime(team), // item 68: sem a 079 vale 5
        // Sem a migração 073 as colunas não vêm — valem os padrões (tudo ligado, sem bairro).
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

/** PATCH /api/teams/:slug — edita o time (só admin). */
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
    // UM controle, "Escudo do time" — cor principal (teams.cor) + segunda cor + padrão, da paleta fixa.
    const escudo = lerEscudo(b);
    if (escudo.erro) throw new HttpError(400, escudo.erro);
    Object.assign(patch, escudo.patch);
    // Item 68: o padrão de jogadores por time (o "Novo jogo" já vem com ele).
    if ('jogadores_por_time' in b) {
      const n = lerJogadoresPorTime(b.jogadores_por_time);
      if (n === undefined) throw new HttpError(400, 'Escolha de 2 a 11 jogadores por time.');
      patch.jogadores_por_time = n;
    }
    if ('publica' in b) patch.publica = !!b.publica;
    if ('mostrar_gols' in b) patch.mostrar_gols = !!b.mostrar_gols;
    // "Artilheiro do dia" e "Destaque do dia" — o editor de resultado só oferece a seção quando ligado.
    if ('mostrar_artilheiro' in b) patch.mostrar_artilheiro = !!b.mostrar_artilheiro;
    if ('mostrar_destaque' in b) patch.mostrar_destaque = !!b.mostrar_destaque;
    // O artilheiro depende dos gols. A combinação que o time vai TER depois desta gravação (o do pedido, ou
    // o que já estava) não pode ser "gols desligados e artilheiro ligado": o motor recusa. Religar os gols
    // não religa o artilheiro sozinho.
    if ('mostrar_gols' in patch || 'mostrar_artilheiro' in patch) {
      let { data: atual, error: erroAtual } = await supabase.from('teams').select('mostrar_gols, mostrar_artilheiro').eq('id', team.id).maybeSingle();
      // Sem a migração 073 a coluna do artilheiro não existe: só os gols contam (o artilheiro nem pode ser gravado) — vale como desligado,
      // para desligar os gols não esbarrar numa combinação que, sem a coluna, não existe.
      if (erroAtual) {
        const { data: soGols } = await supabase.from('teams').select('mostrar_gols').eq('id', team.id).maybeSingle();
        atual = { ...soGols, mostrar_artilheiro: false };
      }
      const depois = {
        mostrar_gols: 'mostrar_gols' in patch ? patch.mostrar_gols : atual?.mostrar_gols,
        mostrar_artilheiro: 'mostrar_artilheiro' in patch ? patch.mostrar_artilheiro : atual?.mostrar_artilheiro,
      };
      if (!combinacaoDePremiosCoerente(depois)) throw new HttpError(400, MSG_ARTILHEIRO_PRECISA_DOS_GOLS);
    }
    if ('localizacao' in b) patch.localizacao = b.localizacao ? String(b.localizacao).trim().slice(0, 100) : null;
    if ('descricao' in b) patch.descricao = b.descricao ? String(b.descricao).trim().slice(0, 300) : null;
    // GEO (opt-in): guarda o nome da CIDADE (texto) + o ponto ARREDONDADO (a morada exacta nunca entra).
    // Limpar a cidade tira o time da busca por distância. Regra em utils/cidade.js: cidade DA LISTA →
    // o ponto vem da lista; fora dela → Nominatim; nada achou → guarda o texto e LIMPA o ponto (o de antes
    // era de outra cidade; sem ponto o Explorar casa por texto). Cidade igual à de antes (o painel reenvia
    // o campo a cada "Salvar") não geocodifica de novo nem mexe no ponto.
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
          // A cidade mudou, o fuso acompanha — derivado do ponto da cidade; sem ponto, fica o que o time tinha.
          const fusoDaCidade = fusoDaCoordenada(cid.geo?.lat, cid.geo?.lng);
          if (fusoDaCidade) patch.fuso = fusoDaCidade;
        }
      }
    }
    // O bairro. O ponto do time é o do bairro quando o motor o acha perto da cidade; sem
    // bairro (ou sem cidade onde pôr um) volta a ser o da cidade. O painel reenvia cidade e bairro a cada
    // "Salvar": bairro igual ao de antes, com a cidade igual, não geocodifica de novo nem mexe no ponto.
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
    // Migração 076 por aplicar: sem `fuso` o resto da edição vale igual (o time continua no padrão America/Sao_Paulo).
    if (error && 'fuso' in patch && erroDaColunaFuso(error)) {
      delete patch.fuso;
      ({ data: updated, error } = await supabase.from('teams').update(patch).eq('id', team.id).select().single());
    }
    // Migração 066 por aplicar: sem `cidade_normalizada` o texto e o ponto da cidade continuam a valer.
    if (error && /cidade_normalizada/i.test(error.message || '')) {
      const sem066 = { ...patch }; delete sem066.cidade_normalizada;
      ({ data: updated, error } = await supabase.from('teams').update(sem066).eq('id', team.id).select().single());
    }
    // Migração 073 por aplicar: o bairro e os prêmios do time ainda não têm onde ficar — o app diz, em vez de fingir.
    if (error && /bairro|mostrar_artilheiro|mostrar_destaque/i.test(error.message || '')) throw new HttpError(503, 'Essa opção ainda não está disponível.');
    // Migrações 077 (escudo: segunda cor, padrão, as 12 cores) e 079 (jogadores por time) por aplicar: idem.
    if (erroDeEscudoSemMigracao(error) || erroDaColunaJogadoresPorTime(error)) throw new HttpError(503, 'Essa opção ainda não está disponível.');
    // Resiliência: se as colunas geo ainda não existirem (DDL 041 por correr), repete sem elas.
    if (error && /geo_lat|geo_lng|cidade/i.test(error.message || '')) {
      const semGeo = { ...patch }; delete semGeo.geo_lat; delete semGeo.geo_lng; delete semGeo.cidade; delete semGeo.cidade_normalizada;
      ({ data: updated, error } = await supabase.from('teams').update(semGeo).eq('id', team.id).select().single());
    }
    if (error) throw new HttpError(500, error.message);
    res.json({
      team: { ...updated, fuso: fusoDoTime(updated), ...escudoDoTime(updated), jogadores_por_time: jogadoresPorTimeDoTime(updated) },
      ...(geoInfo ? { geo: geoInfo } : {}),
      ...(bairroInfo ? { bairro: bairroInfo } : {}),
    });
  })
);

/**
 * PUT /api/teams/:slug/brilhante-kit { kitId } — o dono escolhe o uniforme das
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

/** Só o admin do time passa — e ANTES de ler e analisar a imagem: a análise de conteúdo (NSFW) custa CPU, e quem não é do time não deve poder gastá-la. */
async function soAdminDoTime(req, res, next) {
  try {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem mudar o logo.');
    req.timeDoLogo = team;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * POST /api/teams/:slug/logo — carrega o logo do time (só admin; PNG/JPG/WEBP, máx 2MB).
 * LEIS DA SEGURANÇA: filtro NSFW (explícito → 403) ANTES de guardar; arquivo no bucket
 * PRIVADO "avatars" (path logos/{teamId}); o URL é assinado/proxied na fronteira da API
 * (middleware mediaUrls), como os avatares. EscudoEquipa/TeamAvatar já mostram o logo_url.
 */
router.post(
  '/api/teams/:slug/logo',
  requireAuth,
  soAdminDoTime,
  logoMiddleware,
  // SEGURANCA-REVISAO-10SET.md secção 3: além do mimetype declarado pelo multer,
  // confirma que decodifica como imagem de verdade (mesmo princípio do avatar, utils/olheiroEntrada.js).
  verificarImagemReal,
  // Fail-CLOSED aqui (diferente do avatar): o logo é visível a qualquer
  // visitante do time sem sessão, então um erro técnico na análise bloqueia
  // em vez de deixar passar.
  filtroNSFWFailClosed,
  asyncHandler(async (req, res) => {
    const team = req.timeDoLogo; // já conferido por soAdminDoTime, antes de a imagem ser lida
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
 * DELETE /api/teams/:slug/logo — remove o logo do time (só admin).
 * Sem logo, EscudoEquipa volta a desenhar o escudo (editor de escudo, Ajustes). O arquivo
 * sai do bucket nas 3 extensões possíveis (o upload grava em path fixo "logos/{teamId}.{ext}";
 * sem saber qual foi a última, tenta as 3 — a que não existir simplesmente não apaga nada).
 */
router.delete(
  '/api/teams/:slug/logo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem remover o logo.');

    // Best-effort: a limpeza do arquivo no bucket nunca pode travar a remoção do logo.
    try {
      await supabase.storage.from('avatars').remove(Object.values(LOGO_EXT).map((ext) => `logos/${team.id}.${ext}`));
    } catch { /* storage fora do ar, ou nada para apagar — segue */ }

    const { error } = await supabase.from('teams').update({ logo_url: null }).eq('id', team.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

// Os membros do time (routes/membrosDoTime.js).
router.use(require('./membrosDoTime'));

// Convites e pedidos de entrada (routes/convitesDoTime.js).
router.use(require('./convitesDoTime'));

/** GET /api/teams/:slug/stats — estatísticas agregadas do time (só admin). */
router.get(
  '/api/teams/:slug/stats',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver as estatísticas.');

    // Jogos do time.
    const { data: games } = await supabase
      .from('games')
      .select('id, data, local, status, cancelado')
      .eq('team_id', team.id);
    const ativos = (games || []).filter((g) => g.status !== 'cancelado');
    // "Mais presente" e a média de confirmações só contam jogo que já aconteceu (confirmar é "vou", não "fui").
    const aconteceram = new Set(idsDosJogosQueAconteceram(games));

    // Membros (com stats + dados do usuário).
    const { data: members } = await supabase
      .from('team_members')
      .select('user_id, gols, users ( nome, nome_jogador, avatar_url )')
      .eq('team_id', team.id);
    const total_membros = (members || []).length;

    // Confirmações por jogo e por usuário.
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
        if (aconteceram.has(p.game_id)) confByUser[p.user_id] = (confByUser[p.user_id] || 0) + 1;
      }
    }

    const jaJogados = ativos.filter((g) => aconteceram.has(g.id));
    const totalConf = jaJogados.reduce((s, g) => s + (confByGame[g.id] || 0), 0);
    const media_confirmacoes = jaJogados.length ? Math.round((totalConf / jaJogados.length) * 10) / 10 : 0;

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
      proximo_jogo = {
        id: g.id,
        date: g.data,
        time: horaNoFuso(g.data, fusoDoTime(team)), // HH:MM no relógio do campo (não o do servidor)
        fuso: fusoDoTime(team),
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
