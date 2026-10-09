// Futty v2.0 — Funções puras por trás dos GETs que a tela Início consumia em
// paralelo (routes/inicio.js chama tudo de uma vez; cada rota antiga chama a
// MESMA função daqui, para nunca divergir do JSON que outras telas dependem).
//
// Motivo: motor em São Paulo, utilizador em Lisboa (~240ms/pedido) —
// os ~13 pedidos do Início ao abrir davam 3-4s só de latência de rede, antes de
// qualquer dado chegar. GET /api/inicio junta tudo num round-trip só.
const { supabase, getTeamBySlug, getRole, getUserById, ensureUserRow, requireTeamMember, loadGame } = require('../utils/db');
const { HttpError } = require('../utils/http');
const { golosDoJogador } = require('../utils/agregados');
const { notaParaExibir } = require('../utils/helpers');
const { ehAdulto } = require('../utils/rostoPublico');
const { temIdadeMinima } = require('../utils/idade');
const { temFigurinhaIA, avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const gabineteStore = require('../utils/gabineteStore');
const denunciaStore = require('../utils/denunciaStore');
const { pendenciasDoTime } = require('../utils/pendenciasAdmin'); // o card "Seu time"
const { criarCache } = require('../utils/cacheQuente');
const { idsQueSoOrganizam, timesEmQueSoOrganiza } = require('../utils/soOrganiza');
const { normalizarFuso, lerComFuso } = require('../utils/fuso');

// ─── GET /api/me ──────────────────────────────────────────────────────────────
const PERFIL_COLS_BASE =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo, mostrar_rosto_publico, avatar_generico';
// figurinha_status/_em (migração 051) — colunas novas; ver resiliência em
// obterPerfilResiliente() abaixo (mesmo padrão de `historico` em games.js).
const PERFIL_COLS_FIGURINHA = `${PERFIL_COLS_BASE}, figurinha_status, figurinha_status_em`;
// foto_original_url (migração 057) — "Ajustar enquadramento" (Figurinha.jsx)
// precisa dela para saber se reabre o CropModal sobre a original ou (fail-safe,
// sem ela) sobre o recorte atual. Camada própria de resiliência, igual à de cima.
const PERFIL_COLS = `${PERFIL_COLS_FIGURINHA}, foto_original_url`;
const AVATARES_GENERICOS = ['m1', 'm2', 'm3', 'f1', 'f2', 'f3'];

/**
 * Lê o perfil com PERFIL_COLS (figurinha_status/_em + foto_original_url); se
 * alguma migração (051, 057) ainda não tiver corrido em produção, repete sem
 * as colunas dela — para o deploy do código nunca depender da ordem em que o
 * Pedro corre as migrações, nem de terem corrido as duas.
 */
async function obterPerfilResiliente(userId) {
  const { data, error } = await supabase.from('users').select(PERFIL_COLS).eq('id', userId).maybeSingle();
  if (!error) return data;
  if (/foto_original_url/i.test(error.message || '')) {
    const { data: semOriginal, error: e2 } = await supabase.from('users').select(PERFIL_COLS_FIGURINHA).eq('id', userId).maybeSingle();
    if (!e2) return semOriginal;
    if (/figurinha_status/i.test(e2.message || '')) {
      const { data: semNenhuma } = await supabase.from('users').select(PERFIL_COLS_BASE).eq('id', userId).maybeSingle();
      return semNenhuma;
    }
    return null;
  }
  if (/figurinha_status/i.test(error.message || '')) {
    const { data: semFigurinha } = await supabase.from('users').select(PERFIL_COLS_BASE).eq('id', userId).maybeSingle();
    return semFigurinha;
  }
  return null;
}

/**
 * Marca figurinha_status (best-effort, NUNCA lança) — usado por
 * POST /api/me/avatar/ai. Separado de propósito de qualquer update que
 * devolva erro ao chamador: se a migração 051 ainda não tiver corrido, isto
 * falha em silêncio e a geração real do avatar continua intacta (o avatar_url/
 * kit_ativo nunca viajam no mesmo UPDATE que estas 2 colunas novas).
 */
async function marcarFigurinhaStatus(userId, status) {
  try {
    const { error } = await supabase
      .from('users')
      .update({ figurinha_status: status, figurinha_status_em: new Date().toISOString() })
      .eq('id', userId);
    if (error) console.error('[figurinha-status] update falhou (migração 051 por correr?):', error.message);
  } catch (e) {
    console.error('[figurinha-status] update falhou:', e.message);
  }
}

// Maioridade (IDADE_MINIMA, 18) calculada em runtime pela régua do cadastro (utils/idade.js):
// adulto se a data é válida e a pessoa já fez 18 anos. Sem data → false (fail-closed).
function calcIsAdult(birthdate) {
  return temIdadeMinima(birthdate);
}

// Figurinha automática do cadastro: 'gerando' preso há mais de 3min
// (POST /api/me/avatar/ai que nunca voltou a escrever — crash do processo,
// timeout do fal, etc.) conta como 'falhou' na LEITURA — sem precisar de um
// job à parte para limpar. Calculado a cada leitura, nunca persistido aqui.
const FIGURINHA_GERANDO_TIMEOUT_MS = 3 * 60 * 1000;
function calcFigurinhaStatus(status, statusEm) {
  if (status === 'gerando' && statusEm && Date.now() - new Date(statusEm).getTime() > FIGURINHA_GERANDO_TIMEOUT_MS) {
    return 'falhou';
  }
  return status || null;
}

/** Utilizador autenticado + stats agregadas. Garante a linha em public.users. */
async function obterMe(user) {
  const userId = user.id;
  await ensureUserRow(user);

  const [perfil, jogosRows, gols, voteRows, slotRows, brilhanteRows, historicoRows] = await Promise.all([
    obterPerfilResiliente(userId),
    supabase
      .from('game_players')
      .select('games ( data, status, cancelado )')
      .eq('user_id', userId)
      .eq('confirmado', true)
      .then((r) => r.data),
    golosDoJogador(userId),
    supabase.from('votes').select('nota').eq('para_user_id', userId).then((r) => r.data),
    supabase.from('user_avatar_slots').select('kit_id').eq('user_id', userId).then((r) => r.data),
    // tem_figurinha (abaixo): existência basta, .limit(1). r.data
    // vem null (não []) se a tabela/coluna faltar — tratado como "sem sinal
    // nenhum", nunca erro (mesmo padrão de slotRows acima).
    supabase.from('brilhantes_time').select('user_id').eq('user_id', userId).limit(1).then((r) => r.data),
    supabase.from('user_avatar_historico').select('id').eq('user_id', userId).limit(1).then((r) => r.data),
  ]);

  const agora = Date.now();
  const jogos = (jogosRows || []).filter((r) => {
    const g = r.games;
    if (!g || g.cancelado || g.status === 'cancelado') return false;
    return g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora);
  }).length;

  const totalVotos = voteRows ? voteRows.length : 0;
  const mediaInterna = totalVotos ? voteRows.reduce((sum, v) => sum + Number(v.nota), 0) / totalVotos : null;
  const nota = totalVotos >= 3 ? notaParaExibir(mediaInterna) : null;

  const slots = (slotRows || []).map((r) => r.kit_id);

  // tem_figurinha é calculado aqui, na fonte: kit_ativo||'dark-gold' (linha abaixo)
  // faz toda conta nova parecer "já tem figurinha" pro frontend (Figurinha.jsx
  // usava !!kit_ativo). Cobre os 3 sinais reais de "já gerou
  // alguma": um slot pago (brilhantes_time), uma no histórico
  // (user_avatar_historico, migração 057) ou o avatar ATUAL ser um arquivo
  // de figurinha nosso (cobre quem gerou antes da 057 existir e nunca tem
  // linha no histórico). O 3º sinal olha o NOME do arquivo
  // (utils/figurinhaRegra.js), a mesma regra do upload de foto — não `avatar_url ≠
  // foto_url` + status 'pronta', porque a foto do Google copiada pelo trigger
  // handle_new_user contava como figurinha.
  const temFigurinha = temFigurinhaIA({ brilhanteRows, historicoRows, avatarUrl: perfil?.avatar_url });

  return {
    user: {
      id: userId,
      email: user.email,
      nome: perfil?.nome || null,
      avatar_url: perfil?.avatar_url || null,
      foto_url: perfil?.foto_url || null,
      foto_original_url: perfil?.foto_original_url || null,
      nome_jogador: perfil?.nome_jogador || null,
      cor_preferida: perfil?.cor_preferida || null,
      telefone: perfil?.telefone || null,
      avatar_ia_creditos: perfil?.avatar_ia_creditos ?? 3,
      cor_frame: perfil?.cor_frame || 'dourado',
      fundo_figurinha: perfil?.fundo_figurinha || 'estadio',
      plan: perfil?.plan || 'free',
      avatar_ia_mes: perfil?.avatar_ia_mes ?? 0,
      avatar_ia_reset: perfil?.avatar_ia_reset || null,
      is_super_admin: perfil?.is_super_admin || false,
      birthdate: perfil?.birthdate || null,
      is_adult: calcIsAdult(perfil?.birthdate),
      mostrar_rosto_publico: typeof perfil?.mostrar_rosto_publico === 'boolean' ? perfil.mostrar_rosto_publico : true,
      kit_ativo: perfil?.kit_ativo || null,
      tem_figurinha: temFigurinha,
      // O card mostra AGORA uma figurinha nossa (arquivo -ai- no bucket), pela regra única
      // (utils/figurinhaRegra.js). As telas não decidem isto por foto_url ≠ avatar_url: com a foto do
      // Google em avatar_url, a foto da pessoa iria para o card como se fosse figurinha (seletor de
      // fundos, zoom abaixo da moldura, faixas vazias).
      figurinha_ativa: avatarEhFigurinhaNossa(perfil?.avatar_url),
      avatar_generico: AVATARES_GENERICOS.includes(perfil?.avatar_generico) ? perfil.avatar_generico : null,
      figurinha_status: calcFigurinhaStatus(perfil?.figurinha_status, perfil?.figurinha_status_em),
      onboarding_completo: user.user_metadata?.onboarding_completo === true,
      tour_inicio_visto: user.user_metadata?.tour_inicio_visto === true,
    },
    slots,
    stats: { nota, jogos: jogos || 0, gols },
  };
}

// ─── Os vínculos da pessoa com os times — UMA consulta para todas as partes do Início ─────────────────────────────────
// Sem isto o /api/inicio perguntaria ao banco quem é membro de quê ONZE vezes (times, convites,
// votações, denúncias… cada parte com o seu select de team_members) e, pior, em fila: a parte seguinte só começaria depois de
// os times voltarem. Medido (local, conta com 2 times): 31 consultas em 4 idas seguidas ao banco, ~990 ms de motor — e a conta
// de 1 time custava o mesmo, porque o que pesa é a fila de idas, não o volume. Por isso a consulta sai uma vez, no instante zero, e
// cada parte recebe o resultado pronto. As funções soltas (rotas antigas) continuam a fazer a sua própria consulta.
//
// O select é a união do que cada parte lia (colunas que já existem em produção: eram lidas por elas).
const VINCULOS_SELECT_SEM_FUSO = 'team_id, role, ausente_proximo, created_at, teams ( id, nome, slug, cor, cidade, criado_por, created_at, logo_url, cor_fundo, modo_visibilidade, brilhante_ativo, brilhante_kit, brilhante_limite, manto_proprio, revotar_pedido_em )';
// O fuso do time vai junto, na mesma consulta (sem ida nova). Sem a migração 076 a leitura repete sem ele.
// Com as outras colunas novas do time (escudo, jogadores por time) — mesma tolerância, coluna a coluna.
const vinculosSelect = (novas) => VINCULOS_SELECT_SEM_FUSO.replace(' revotar_pedido_em )', ` revotar_pedido_em, ${novas} )`);

async function obterVinculos(userId) {
  const { data, error } = await lerComFuso((novas) => supabase
    .from('team_members')
    .select(novas ? vinculosSelect(novas) : VINCULOS_SELECT_SEM_FUSO)
    .eq('user_id', userId)
    .order('created_at', { ascending: true }));
  if (error) throw new HttpError(500, error.message);
  return data || [];
}

// ─── GET /api/teams ───────────────────────────────────────────────────────────
/** Os times da pessoa, com o papel, o `joga` e o que a Figurinha precisa do pacote — a partir dos vínculos já lidos. */
function montarTeams(vinculos, soOrganiza) {
  return (vinculos || [])
    .filter((row) => row.teams)
    .map((row) => {
      // `revotar_pedido_em` veio no select compartilhado, mas nunca fez parte desta resposta: não entra.
      const { revotar_pedido_em: _revotar, ...time } = row.teams; // eslint-disable-line no-unused-vars
      return { ...time, fuso: normalizarFuso(time.fuso), role: row.role, joga: !soOrganiza.has(row.teams.id) };
    });
}

/** Pedidos de entrada pendentes por equipa (só onde sou admin) → badge no chip. Muda os objetos de `teams`. */
async function contarPedidosPendentes(teams) {
  const adminIds = teams.filter((t) => t.role === 'admin').map((t) => t.id);
  if (!adminIds.length) return teams;
  const { data: peds } = await supabase.from('team_join_requests').select('team_id').in('team_id', adminIds).eq('status', 'pending');
  const contagem = {};
  for (const p of peds || []) contagem[p.team_id] = (contagem[p.team_id] || 0) + 1;
  for (const t of teams) if (t.role === 'admin') t.pedidos_pendentes = contagem[t.id] || 0;
  return teams;
}

// ─── O card "Seu time" do Início ─────────────────────────────────────────────────────────────────────────────────────
// Para cada time em que a pessoa é admin: as pendências (utils/pendenciasAdmin.js) — pedidos de entrada, o próximo jogo sem
// presença aberta, o último sem resultado, denúncias à espera. Três leituras em paralelo (pedidos, jogos, denúncias), fora do
// caminho crítico do Início. Sem time de admin, lista vazia (a tela não mostra o card).
const JOGO_PENDENCIA_COLS = 'id, team_id, data, status, cancelado, resultado_nivel, rsvp_aberto, rsvp_fechado';
const ULTIMOS_PARA_PENDENCIA = 4; // o último que aconteceu, com folga para os cancelados

async function obterSeuTime(teams) {
  const admin = (teams || []).filter((t) => t.role === 'admin');
  if (!admin.length) return [];
  const ids = admin.map((t) => t.id);
  const agoraIso = new Date().toISOString();
  const [pedidos, proximos, passados, denuncias] = await Promise.all([
    supabase.from('team_join_requests').select('team_id').in('team_id', ids).eq('status', 'pending'),
    supabase.from('games').select(JOGO_PENDENCIA_COLS).in('team_id', ids).gte('data', agoraIso).order('data', { ascending: true }).limit(ids.length * 4),
    Promise.all(ids.map((id) => supabase.from('games').select(JOGO_PENDENCIA_COLS).eq('team_id', id).lt('data', agoraIso)
      .order('data', { ascending: false }).limit(ULTIMOS_PARA_PENDENCIA))),
    Promise.all(ids.map((id) => Promise.resolve().then(() => casosDaEquipaComCache(id)).catch(() => []))),
  ]);
  const pedidosPorTime = {};
  for (const p of pedidos.data || []) pedidosPorTime[p.team_id] = (pedidosPorTime[p.team_id] || 0) + 1;
  return admin.map((t, i) => {
    const jogos = [...(proximos.data || []).filter((g) => g.team_id === t.id), ...(passados[i]?.data || [])];
    const casos = (denuncias[i] || []).filter((c) => c.estado === 'fila' || c.estado === 'escalada');
    return {
      team_id: t.id,
      slug: t.slug,
      nome: t.nome,
      fuso: normalizarFuso(t.fuso),
      pendencias: pendenciasDoTime({ pedidos: pedidosPorTime[t.id] || 0, jogos, denuncias: casos.length }),
    };
  });
}

async function obterTeams(userId) {
  // Em paralelo, os times em que a pessoa só organiza (`joga: false` nos dela; ela administra, não joga).
  // As colunas do pacote de figurinhas entram no MESMO select (não há ida nova): é o que deixa a Figurinha
  // abrir a partir do que o /api/inicio já trouxe, em vez de pedir /api/brilhantes/estado só para saber se o time tem pacote.
  const [vinculos, soOrganiza] = await Promise.all([obterVinculos(userId), timesEmQueSoOrganiza(userId)]);
  const teams = montarTeams(vinculos, soOrganiza);
  await contarPedidosPendentes(teams);
  return { teams };
}

// ─── GET /api/games/my-invites ────────────────────────────────────────────────
// VELOCIDADE 6A (15-set): eram 3 idas EM SÉRIE (team_members → games →
// game_players). As presenças passam a vir embutidas nos jogos (select do
// PostgREST), o que junta as duas últimas: ficam 2.
// RODADA 29B (bloco 2, B) — a lista de jogos do Início deixa de crescer com o histórico. A tela usa só duas coisas dela:
// "Próximos Jogos" (tudo o que ainda não acabou) e "Últimos Jogos" (os 3 mais recentes, por time). Com `limitar` o motor devolve
// exatamente isso — os jogos que ainda vão acontecer + os últimos ULTIMOS_POR_TIME encerrados de cada time — em vez de TODO
// jogo que o time já teve, com a presença de cada um (uma conta com anos de peladas mandava centenas de jogos e milhares de
// linhas de presença para desenhar três cartões). A rota antiga (/api/games/my-invites, que o app não usa) segue completa.
const ULTIMOS_POR_TIME = 3;
// Margem para os encerrados que a tela descarta (cancelados) não comerem as vagas dos 3 que ela mostra.
const MARGEM_ULTIMOS = 8;
// `seed` sai do JSON do resultado (só ela, não os times inteiros): sem seed, os times foram montados à mão e o card
// diz "Ver times", não "Ver sorteio".
const JOGO_COLS = 'id, team_id, data, local, status, sorteio_realizado, cancelado, seed:times_resultado->seed, game_players ( user_id, confirmado )';

async function jogosDoInicio(teamIds) {
  const agoraIso = new Date().toISOString();
  const [proximos, ...recentes] = await Promise.all([
    supabase.from('games').select(JOGO_COLS).in('team_id', teamIds).or(`data.gte.${agoraIso},data.is.null`).order('data', { ascending: true }),
    ...teamIds.map((id) => supabase.from('games').select(JOGO_COLS).eq('team_id', id).lt('data', agoraIso).order('data', { ascending: false }).limit(MARGEM_ULTIMOS)),
  ]);
  for (const r of [proximos, ...recentes]) if (r.error) return { error: r.error };
  const porId = new Map();
  for (const g of [...(proximos.data || []), ...recentes.flatMap((r) => r.data || [])]) porId.set(g.id, g);
  return { data: [...porId.values()] };
}

/** Do que a tela guarda dos encerrados: os ULTIMOS_POR_TIME mais recentes de cada time, sem os cancelados. */
function aparar(listaFormatada) {
  // Sem data = o fim da fila (o Postgres põe NULL por último na ordem ascendente, e a lista sempre veio assim).
  const quando = (g) => (g.date ? new Date(g.date).getTime() : Infinity);
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0); // Infinity - Infinity daria NaN
  const porTime = new Map();
  const mantidos = [];
  for (const g of [...listaFormatada].sort((a, b) => cmp(quando(b), quando(a)))) {
    if (g.status !== 'finished') { mantidos.push(g); continue; }
    if (g.cancelado) continue;
    const n = porTime.get(g.team_id) || 0;
    if (n < ULTIMOS_POR_TIME) { porTime.set(g.team_id, n + 1); mantidos.push(g); }
  }
  return mantidos.sort((a, b) => cmp(quando(a), quando(b)));
}

async function obterConvites(userId, { vinculos = null, soOrganiza: soOrganizaDado = null, limitar = false } = {}) {
  // `eu_jogo` por jogo — quem só organiza o time não responde presença (a tela esconde o "Vou / Não vou").
  // O /api/inicio já leu os vínculos e o `joga` uma vez e os passa; sozinha (rota antiga) a função lê os seus.
  const [memberships, soOrganiza] = vinculos
    ? [vinculos, soOrganizaDado || new Set()]
    : await Promise.all([
      lerComFuso((novas) => supabase
        .from('team_members')
        .select(/fuso/.test(novas) ? 'team_id, ausente_proximo, teams ( id, nome, slug, cidade, fuso )' : 'team_id, ausente_proximo, teams ( id, nome, slug, cidade )')
        .eq('user_id', userId)).then((r) => r.data),
      timesEmQueSoOrganiza(userId),
    ]);
  const teamById = {};
  const ausenteByTeam = {};
  for (const m of memberships || []) {
    if (m.teams) teamById[m.team_id] = m.teams;
    ausenteByTeam[m.team_id] = !!m.ausente_proximo;
  }
  const teamIds = Object.keys(teamById);
  if (!teamIds.length) return { games: [] };

  const { data: games, error } = limitar
    ? await jogosDoInicio(teamIds)
    : await supabase
      .from('games')
      .select(JOGO_COLS)
      .in('team_id', teamIds)
      .order('data', { ascending: true });
  if (error) throw new HttpError(500, error.message);

  const counts = {};
  const myStatus = {};
  for (const g of games || []) {
    for (const row of g.game_players || []) {
      if (row.confirmado) counts[g.id] = (counts[g.id] || 0) + 1;
      if (row.user_id === userId) myStatus[g.id] = row.confirmado ? 'going' : 'not_going';
    }
  }

  const now = Date.now();
  const list = (games || []).map((g) => {
    const past = g.data && new Date(g.data).getTime() < now;
    const cancelado = !!g.cancelado || g.status === 'cancelado';
    const finished = g.status === 'terminado' || cancelado || past;
    const status = finished ? 'finished' : g.sorteio_realizado ? 'drawn' : 'scheduled';
    const team = teamById[g.team_id] || {};
    return {
      id: g.id,
      name: g.local || 'Jogo',
      date: g.data,
      location: g.local || null,
      confirmed_count: counts[g.id] || 0,
      status,
      cancelado,
      user_status: myStatus[g.id] ?? null,
      team_id: g.team_id,
      team_name: team.nome || null,
      team_slug: team.slug || null,
      // A hora do jogo é a do campo — o fuso do time vai no próprio jogo (aqui o time não vem embutido).
      fuso: normalizarFuso(team.fuso),
      ausente_proximo: ausenteByTeam[g.team_id] || false,
      eu_jogo: !soOrganiza.has(g.team_id),
      montado_a_mao: !!g.sorteio_realizado && g.seed == null,
    };
  });

  return { games: limitar ? aparar(list) : list };
}

// ─── GET /api/me/pedidos ──────────────────────────────────────────────────────
async function obterPedidos(userId) {
  const { data, error } = await supabase
    .from('team_join_requests')
    .select('id, status, updated_at, teams ( id, nome, slug, cor, logo_url )')
    .eq('user_id', userId)
    .in('status', ['approved', 'rejected', 'pending'])
    .order('updated_at', { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return {
    pedidos: (data || []).map((p) => ({
      id: p.id,
      status: p.status,
      updated_at: p.updated_at,
      team: p.teams ? { id: p.teams.id, nome: p.teams.nome, slug: p.teams.slug, cor: p.teams.cor, logo_url: p.teams.logo_url } : null,
    })),
  };
}

// ─── GET /api/me/votacoes-pendentes ───────────────────────────────────────────
// São 2 idas ao banco, em vez de 4 em série (team_members → (teams, votes,
// games) → as minhas presenças → as presenças dos colegas):
//   · os dados das equipas vêm embutidos no team_members (mata a query `teams`);
//   · as presenças vêm embutidas nos jogos, e as minhas e as dos colegas saem
//     do mesmo conjunto (matam as duas idas a game_players).
async function obterVotacoesPendentes(userId, { vinculos = null } = {}) {
  // O /api/inicio passa os vínculos que já leu (uma consulta a menos, e uma ida a menos na fila).
  const minhas = vinculos || (await supabase
    .from('team_members')
    .select('team_id, teams ( id, slug, nome, revotar_pedido_em )')
    .eq('user_id', userId)).data;
  const teams = [...new Map((minhas || []).filter((m) => m.teams).map((m) => [m.teams.id, m.teams])).values()];
  const teamIds = teams.map((t) => t.id);
  if (!teamIds.length) return { pendentes: [] };

  const [{ data: votos }, { data: jogosDasEquipas }] = await Promise.all([
    supabase.from('votes').select('team_id, para_user_id, updated_at').eq('de_user_id', userId).in('team_id', teamIds),
    // Só pede avaliação de quem o utilizador REALMENTE jogou junto — jogos já
    // ENCERRADOS em que ambos estiveram confirmados.
    supabase.from('games').select('id, team_id, data, status, cancelado, game_players ( user_id, confirmado )').in('team_id', teamIds),
  ]);
  const agora = Date.now();
  // Primeiro os jogos encerrados em que EU estive; depois, nesses mesmos jogos,
  // quem mais esteve — é essa gente que fica por avaliar.
  const meusJogos = [];
  for (const g of jogosDasEquipas || []) {
    const cancelado = !!g.cancelado || g.status === 'cancelado';
    const encerrado = !cancelado && (g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora));
    if (!encerrado) continue;
    const presencas = g.game_players || [];
    if (presencas.some((p) => p.user_id === userId && p.confirmado)) meusJogos.push({ teamId: g.team_id, presencas });
  }
  const colegasPorTeam = {};
  for (const { teamId, presencas } of meusJogos) {
    for (const p of presencas) {
      if (!p.confirmado || p.user_id === userId) continue;
      (colegasPorTeam[teamId] = colegasPorTeam[teamId] || new Set()).add(p.user_id);
    }
  }

  const pendentes = [];
  for (const t of teams || []) {
    const elegiveis = colegasPorTeam[t.id] || new Set();
    const total = elegiveis.size;
    const meus = (votos || []).filter((v) => v.team_id === t.id && elegiveis.has(v.para_user_id));
    const votados = new Set(meus.map((v) => v.para_user_id)).size;
    const faltam = Math.max(0, total - votados);
    const maxUpdated = meus.reduce((mx, v) => Math.max(mx, v.updated_at ? new Date(v.updated_at).getTime() : 0), 0);
    const pedidoEm = t.revotar_pedido_em ? new Date(t.revotar_pedido_em).getTime() : 0;
    const pedido_revotacao = total > 0 && pedidoEm > 0 && pedidoEm > maxUpdated;
    if (total > 0 && (faltam > 0 || pedido_revotacao)) {
      pendentes.push({ slug: t.slug, nome: t.nome, faltam, pedido_revotacao });
    }
  }
  pendentes.sort((a, b) => (b.pedido_revotacao - a.pedido_revotacao) || (b.faltam - a.faltam));
  return { pendentes };
}

// ─── GET /api/denuncias/meus-desfechos ────────────────────────────────────────
// VELOCIDADE 6A (15-set): isto corria em TODO /api/inicio e fazia, por equipa,
// um `list` no Storage MAIS um download por ficheiro de caso. Numa equipa com
// 20 denúncias eram 21 idas ao Storage só para saber um número que quase sempre
// é zero. Cache de 5 minutos por equipa, esquecida assim que um caso é gravado
// (denunciaStore.aoGravar) — o utilizador vê o desfecho da própria denúncia na
// mesma, sem pagar o preço em cada abertura da tela.
// Velocidade 7A: pedidos simultâneos do mesmo time esperam a MESMA listagem, e
// depois dos 5 min sai a conhecida enquanto a nova é buscada por trás.
const DESFECHOS_TTL_MS = 5 * 60 * 1000;
const casosPorEquipa = criarCache({ nome: 'denuncias', ttlMs: DESFECHOS_TTL_MS, max: 2000 });

denunciaStore.aoGravar((teamId) => casosPorEquipa.invalidar(teamId || '_sem'));

function casosDaEquipaComCache(teamId) {
  return casosPorEquipa.obter(teamId || '_sem', () => denunciaStore.listarEquipa(teamId));
}

async function obterDesfechosDenuncias(userId, { vinculos = null } = {}) {
  const membros = vinculos || (await supabase.from('team_members').select('team_id').eq('user_id', userId)).data;
  const teamIds = (membros || []).map((m) => m.team_id);
  // Todas as equipas em paralelo (e quase sempre em cache), em vez de um `for` sequencial
  // com 1 download de Storage por equipa.
  const porEquipa = await Promise.all(teamIds.map((tid) => casosDaEquipaComCache(tid)));
  const n = porEquipa.reduce((total, casos) => total + casos.filter((c) => c.reporter_id === userId && c.resolvido_em).length, 0);
  return { total: n }; // só a contagem — nunca o veredicto
}

// ─── GET /api/teams/:slug/votacao-status ──────────────────────────────────
// `conhecido`: quando o chamador já sabe o time e o
// papel — o /api/inicio sabe, veio do obterTeams — salta o requireTeamMember,
// que é mais uma ida ao banco para confirmar o que já se sabe. A rota solta
// continua a chamar sem ele e a validar como sempre.
async function obterVotacaoStatus(slug, userId, conhecido = null) {
  const team = conhecido?.id && conhecido?.role ? conhecido : (await requireTeamMember(slug, userId)).team;

  // Independentes entre si depois de `team` resolvido: saem em paralelo, não em 3 awaits em série.
  const [{ data: membros }, { data: meus }, { data: teamRow }] = await Promise.all([
    supabase.from('team_members').select('user_id').eq('team_id', team.id),
    supabase.from('votes').select('para_user_id, updated_at').eq('team_id', team.id).eq('de_user_id', userId),
    supabase.from('teams').select('revotar_pedido_em').eq('id', team.id).maybeSingle(),
  ]);
  const total = (membros || []).filter((m) => m.user_id !== userId).length;
  const votados = new Set((meus || []).map((v) => v.para_user_id)).size;
  const pedidoEm = teamRow?.revotar_pedido_em ? new Date(teamRow.revotar_pedido_em).getTime() : 0;
  const maxUpdated = (meus || []).reduce((mx, v) => Math.max(mx, v.updated_at ? new Date(v.updated_at).getTime() : 0), 0);
  const pedido_revotacao = pedidoEm > 0 && pedidoEm > maxUpdated;

  return { total, votados, faltam: Math.max(0, total - votados), pedido_revotacao };
}

// ─── GET /api/equipas/:slug/campeonato ────────────────────────────────────
// `conhecido`: o /api/inicio já tem o time e o papel do
// obterTeams — passá-los aqui poupa o getTeamBySlug E o getRole, duas idas ao
// banco só para reconfirmar o que já veio. A rota solta continua a validar.
async function obterCampeonato(slug, userId, conhecido = null) {
  const jaSabido = conhecido?.id && conhecido?.role ? conhecido : null;
  const team = jaSabido || (await getTeamBySlug(slug, 'id, slug'));
  if (!team) throw new HttpError(404, 'Time não encontrado.');

  // role e campeonato só dependem de team.id, não um do outro (saem em paralelo, não
  // sequenciais). O acesso só é confirmado depois —
  // se `role` vier vazio o resultado de campeonato é descartado a seguir.
  const [role, { data: campeonato }] = await Promise.all([
    jaSabido ? jaSabido.role : getRole(team.id, userId),
    supabase.from('campeonatos').select('*').eq('team_id', team.id).order('criado_em', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!role) throw new HttpError(403, 'Não é membro deste time.');
  if (!campeonato) return { campeonato: null };

  const { data: jornadas } = await supabase
    .from('campeonato_jornadas')
    .select('*')
    .eq('campeonato_id', campeonato.id)
    .order('numero', { ascending: true });

  return { campeonato, jornadas: jornadas || [] };
}

// ─── GET /api/jogos/:gameId/rsvp ──────────────────────────────────────────────
// `teamId`: o /api/inicio já sabe de que time é o próximo jogo (veio na lista de jogos). Com ele, o jogo e tudo o
// que só precisa do time e do jogo saem NA MESMA ida ao banco — em fila seriam duas (loadGame, e só depois o resto). Se o jogo
// disser outro time, volta ao caminho de sempre.
async function obterRsvp(gameId, userId, { teamId = null } = {}) {
  const consultasDoTime = (tid) => [
    getRole(tid, userId),
    supabase.from('team_members').select('users ( id, nome, nome_jogador, avatar_url, avatar_generico )').eq('team_id', tid),
    supabase.from('rsvp_respostas').select('user_id, status').eq('game_id', gameId),
    supabase.from('rsvp_espera').select('user_id, posicao').eq('game_id', gameId).order('posicao', { ascending: true }),
    idsQueSoOrganizam(tid),
  ];
  let game;
  let resto;
  if (teamId) {
    // Nenhum depende dos outros: o jogo e as cinco consultas do time correm juntos.
    [game, ...resto] = await Promise.all([loadGame(gameId), ...consultasDoTime(teamId)]);
    if (game && game.teams?.id !== teamId) resto = null; // o jogo é de outro time: refaz abaixo
  } else {
    game = await loadGame(gameId);
  }
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');

  // role, membros, respostas e filaRows só dependem de game/team já
  // carregados — nenhum depende dos outros 3 (saem em paralelo, não em 4
  // awaits em série). O acesso só é confirmado depois — se `role` vier vazio
  // o resto é descartado a seguir.
  if (!resto) resto = await Promise.all(consultasDoTime(game.teams.id));
  const [role, { data: membros }, { data: respostas }, { data: filaRows }, organizam] = resto;
  if (!role) throw new HttpError(403, 'Não é membro deste time.');

  // Quem só organiza o time não está na lista de presença (nem como pendente).
  const users = (membros || []).map((m) => m.users).filter((u) => u && !organizam.has(u.id));
  const statusPorUser = {};
  (respostas || []).forEach((r) => {
    statusPorUser[r.user_id] = r.status;
  });

  const confirmados = users.filter((u) => statusPorUser[u.id] === 'confirmado');
  const max = game.max_jogadores ?? null;
  const lugaresDisponiveis = max != null ? Math.max(0, max - confirmados.length) : null;

  const userById = {};
  for (const u of users) userById[u.id] = u;
  const espera = (filaRows || []).map((r) => {
    const u = userById[r.user_id] || {};
    return { user_id: r.user_id, nome: u.nome_jogador || u.nome || null, avatar_url: u.avatar_url || null, posicao: r.posicao };
  });
  const minhaEspera = (filaRows || []).find((r) => r.user_id === userId);

  return {
    // O prazo de confirmação e a hora do jogo se leem no relógio do campo.
    fuso: normalizarFuso(game.teams?.fuso),
    rsvp_aberto: game.rsvp_aberto || false,
    rsvp_prazo: game.rsvp_prazo || null,
    rsvp_fechado: game.rsvp_fechado || false,
    max_jogadores: max,
    lugares_disponiveis: lugaresDisponiveis,
    cheio: max != null && confirmados.length >= max,
    confirmados,
    recusados: users.filter((u) => statusPorUser[u.id] === 'recusado'),
    pendentes: users.filter((u) => !statusPorUser[u.id]),
    espera,
    minha_posicao_espera: minhaEspera ? minhaEspera.posicao : null,
    eu_jogo: !organizam.has(userId),
  };
}

// ─── GET /api/ads?pagina= ─────────────────────────────────────────────────────
const hojeStr = () => new Date().toISOString().slice(0, 10);
function campanhaAtiva(c, hoje) {
  if (c.estado !== 'ativa') return false;
  if (c.inicio && c.inicio > hoje) return false;
  if (c.fim && c.fim < hoje) return false;
  return true;
}
// FAIL-CLOSED: sem cls → tratado como 18+ (só adulto autenticado vê).
function podeVerCampanha(c, adulto) {
  return (c.cls || '18+') === 'livre' ? true : adulto === true;
}

// PUBLICIDADE EM TODOS OS PLANOS (decisão do dono): Pro/Elite não ficam isentos de
// anúncio — veem METADE das oportunidades elegíveis, nunca zero (o Free continua
// a ver todas). Hash simples e determinístico de
// userId+dia: o MESMO utilizador recebe a MESMA decisão em qualquer tela nesse
// dia (não pisca entre Início/sorteio), e muda sozinho no dia seguinte.
function metadeDasVezes(userId, hoje) {
  const s = `${userId}:${hoje}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 2 === 0;
}

/**
 * O que não muda de página para página: o interruptor geral, as campanhas, a
 * idade e o plano de quem pede. Lido UMA vez (em vez de cinco leituras iguais à
 * tabela `users`, uma por página servida numa sessão).
 */
async function contextoDoAnuncio(userId) {
  const store = await gabineteStore.ler();
  let adulto = false;
  let plano = 'free';
  if (userId && store.ads_ativo !== false) {
    const { data: u } = await supabase.from('users').select('birthdate, plan').eq('id', userId).maybeSingle();
    adulto = ehAdulto(u && u.birthdate);
    plano = u?.plan || 'free';
  }
  return { store, adulto, plano, hoje: hojeStr() };
}

/** Escolhe o anúncio de UMA página a partir do contexto já lido. */
function escolherAd(pagina, { store, adulto, plano, hoje }, userId) {
  if (store.ads_ativo === false) return { ad: null }; // interruptor geral OFF
  if (!store.toggles || store.toggles[pagina] !== true) return { ad: null }; // página OFF

  const elegiveis = (store.campanhas || []).filter(
    (c) => Array.isArray(c.paginas) && c.paginas.includes(pagina) && campanhaAtiva(c, hoje) && podeVerCampanha(c, adulto),
  );
  if (!elegiveis.length) return { ad: null };
  if ((plano === 'pro' || plano === 'elite') && !metadeDasVezes(userId, hoje)) return { ad: null };
  const c = elegiveis[Math.floor(Date.now() / 60000) % elegiveis.length];
  return {
    ad: {
      id: c.id, anunciante: c.anunciante || '', imagem_url: c.imagem_url || null,
      texto: c.texto || c.nome || '', sub: c.sub || c.anunciante || '', cta: c.cta || 'Ver', link: c.link || null,
    },
  };
}

async function obterAd(pagina, userId) {
  return escolherAd(pagina, await contextoDoAnuncio(userId), userId);
}

// As páginas que têm slot. É a mesma lista dos toggles do Gabinete.
const PAGINAS_COM_AD = ['inicio', 'resenha', 'ranking', 'figurinha', 'sorteio', 'p'];

/**
 * TODOS os slots de uma sessão numa resposta.
 *
 * Medido num percurso de 20 segundos: 4 `GET /api/ads?pagina=…` (~500 ms cada, de
 * Lisboa) + 3 `POST /api/ads/evento`, 7 dos 22 pedidos da sessão — mais do que
 * qualquer tela. E o trabalho de servidor era ~0 ms: o custo era só a distância,
 * repetida por tela.
 *
 * As campanhas não mudam no meio de uma sessão (a rotação é por minuto), por
 * isso vêm todas juntas e o app guarda-as por alguns minutos.
 */
async function obterAdsSessao(userId) {
  const contexto = await contextoDoAnuncio(userId);
  const paginas = {};
  for (const p of PAGINAS_COM_AD) paginas[p] = escolherAd(p, contexto, userId).ad;
  return { paginas, validadeMs: VALIDADE_ADS_MS };
}

// Quanto tempo o app pode servir estes anúncios sem voltar a perguntar. A
// rotação entre campanhas elegíveis é por minuto; 4 minutos mantém a conta de
// impressões honesta sem pôr uma ida a São Paulo em cada tela.
const VALIDADE_ADS_MS = 4 * 60 * 1000;

module.exports = {
  obterSeuTime,
  obterMe,
  obterVinculos,
  montarTeams,
  contarPedidosPendentes,
  obterTeams,
  obterConvites,
  obterPedidos,
  obterVotacoesPendentes,
  obterDesfechosDenuncias,
  obterVotacaoStatus,
  obterCampeonato,
  obterRsvp,
  obterAd,
  obterAdsSessao,
  marcarFigurinhaStatus,
};
