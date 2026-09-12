// Futty v2.0 — Funções puras por trás dos GETs que a tela Início consumia em
// paralelo (routes/inicio.js chama tudo de uma vez; cada rota antiga chama a
// MESMA função daqui, para nunca divergir do JSON que outras telas dependem).
//
// Motivo (11-set): motor em São Paulo, utilizador em Lisboa (~240ms/pedido) —
// os ~13 pedidos do Início ao abrir davam 3-4s só de latência de rede, antes de
// qualquer dado chegar. GET /api/inicio junta tudo num round-trip só.
const { supabase, getTeamBySlug, getRole, getUserById, ensureUserRow, requireTeamMember, loadGame } = require('../utils/db');
const { HttpError } = require('../utils/http');
const { golosDoJogador } = require('../utils/agregados');
const { notaParaExibir } = require('../utils/helpers');
const { ehAdulto } = require('../utils/rostoPublico');
const gabineteStore = require('../utils/gabineteStore');
const denunciaStore = require('../utils/denunciaStore');

// ─── GET /api/me ──────────────────────────────────────────────────────────────
const PERFIL_COLS_BASE =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo, mostrar_rosto_publico, avatar_generico';
// figurinha_status/_em (migração 051) — colunas novas; ver resiliência em
// obterPerfilResiliente() abaixo (mesmo padrão de `historico` em games.js).
const PERFIL_COLS = `${PERFIL_COLS_BASE}, figurinha_status, figurinha_status_em`;
const AVATARES_GENERICOS = ['m1', 'm2', 'm3', 'f1', 'f2', 'f3'];

/**
 * Lê o perfil com PERFIL_COLS (inclui figurinha_status/_em); se a migração 051
 * ainda não tiver corrido em produção, repete sem essas 2 colunas — para o
 * deploy do código nunca depender da ordem em que o Pedro corre a migração.
 */
async function obterPerfilResiliente(userId) {
  const { data, error } = await supabase.from('users').select(PERFIL_COLS).eq('id', userId).maybeSingle();
  if (!error) return data;
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

// Maioridade (18+) calculada em runtime: adulto se nasceu até à data de hoje
// menos 18 anos.
function calcIsAdult(birthdate) {
  if (!birthdate) return false;
  const hoje = new Date();
  const limite = new Date(Date.UTC(hoje.getUTCFullYear() - 18, hoje.getUTCMonth(), hoje.getUTCDate()));
  return new Date(birthdate) <= limite;
}

// Figurinha automática do cadastro (12-set): 'gerando' preso há mais de 3min
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

  const [perfil, jogosRows, gols, voteRows, slotRows] = await Promise.all([
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

  return {
    user: {
      id: userId,
      email: user.email,
      nome: perfil?.nome || null,
      avatar_url: perfil?.avatar_url || null,
      foto_url: perfil?.foto_url || null,
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
      kit_ativo: perfil?.kit_ativo || 'dark-gold',
      avatar_generico: AVATARES_GENERICOS.includes(perfil?.avatar_generico) ? perfil.avatar_generico : null,
      figurinha_status: calcFigurinhaStatus(perfil?.figurinha_status, perfil?.figurinha_status_em),
      onboarding_completo: user.user_metadata?.onboarding_completo === true,
      tour_inicio_visto: user.user_metadata?.tour_inicio_visto === true,
    },
    slots,
    stats: { nota, jogos: jogos || 0, gols },
  };
}

// ─── GET /api/teams ───────────────────────────────────────────────────────────
async function obterTeams(userId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('role, teams ( id, nome, slug, cor, criado_por, created_at, logo_url, cor_fundo, modo_visibilidade )')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new HttpError(500, error.message);

  const teams = (data || []).filter((row) => row.teams).map((row) => ({ ...row.teams, role: row.role }));

  // Pedidos de entrada pendentes por equipa (só onde sou admin) → badge no chip.
  const adminIds = teams.filter((t) => t.role === 'admin').map((t) => t.id);
  if (adminIds.length) {
    const { data: peds } = await supabase.from('team_join_requests').select('team_id').in('team_id', adminIds).eq('status', 'pending');
    const contagem = {};
    for (const p of peds || []) contagem[p.team_id] = (contagem[p.team_id] || 0) + 1;
    for (const t of teams) if (t.role === 'admin') t.pedidos_pendentes = contagem[t.id] || 0;
  }

  return { teams };
}

// ─── GET /api/games/my-invites ────────────────────────────────────────────────
async function obterConvites(userId) {
  const { data: memberships } = await supabase
    .from('team_members')
    .select('team_id, ausente_proximo, teams ( id, nome, slug )')
    .eq('user_id', userId);
  const teamById = {};
  const ausenteByTeam = {};
  for (const m of memberships || []) {
    if (m.teams) teamById[m.team_id] = m.teams;
    ausenteByTeam[m.team_id] = !!m.ausente_proximo;
  }
  const teamIds = Object.keys(teamById);
  if (!teamIds.length) return { games: [] };

  const { data: games, error } = await supabase
    .from('games')
    .select('id, team_id, data, local, status, sorteio_realizado, cancelado')
    .in('team_id', teamIds)
    .order('data', { ascending: true });
  if (error) throw new HttpError(500, error.message);

  const ids = (games || []).map((g) => g.id);
  const counts = {};
  const myStatus = {};
  if (ids.length) {
    const { data: gp } = await supabase.from('game_players').select('game_id, user_id, confirmado').in('game_id', ids);
    for (const row of gp || []) {
      if (row.confirmado) counts[row.game_id] = (counts[row.game_id] || 0) + 1;
      if (row.user_id === userId) myStatus[row.game_id] = row.confirmado ? 'going' : 'not_going';
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
      ausente_proximo: ausenteByTeam[g.team_id] || false,
    };
  });

  return { games: list };
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
async function obterVotacoesPendentes(userId) {
  const { data: minhas } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
  const teamIds = [...new Set((minhas || []).map((m) => m.team_id))];
  if (!teamIds.length) return { pendentes: [] };

  const { data: teams } = await supabase.from('teams').select('id, slug, nome, revotar_pedido_em').in('id', teamIds);
  const { data: votos } = await supabase
    .from('votes')
    .select('team_id, para_user_id, updated_at')
    .eq('de_user_id', userId)
    .in('team_id', teamIds);

  // Só pede avaliação de quem o utilizador REALMENTE jogou junto — jogos já
  // ENCERRADOS em que ambos estiveram confirmados.
  const { data: jogosDasEquipas } = await supabase.from('games').select('id, team_id, data, status, cancelado').in('team_id', teamIds);
  const agora = Date.now();
  const teamIdByGame = {};
  const encerradoIds = [];
  for (const g of jogosDasEquipas || []) {
    teamIdByGame[g.id] = g.team_id;
    const cancelado = !!g.cancelado || g.status === 'cancelado';
    const encerrado = !cancelado && (g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora));
    if (encerrado) encerradoIds.push(g.id);
  }
  const { data: minhasPresencas } = encerradoIds.length
    ? await supabase.from('game_players').select('game_id').eq('user_id', userId).eq('confirmado', true).in('game_id', encerradoIds)
    : { data: [] };
  const meusGameIds = [...new Set((minhasPresencas || []).map((p) => p.game_id))];
  const { data: colegasPresencas } = meusGameIds.length
    ? await supabase.from('game_players').select('game_id, user_id').eq('confirmado', true).in('game_id', meusGameIds)
    : { data: [] };
  const colegasPorTeam = {};
  for (const p of colegasPresencas || []) {
    if (p.user_id === userId) continue;
    const tid = teamIdByGame[p.game_id];
    if (!tid) continue;
    (colegasPorTeam[tid] = colegasPorTeam[tid] || new Set()).add(p.user_id);
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
async function obterDesfechosDenuncias(userId) {
  const { data: membros } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
  const teamIds = (membros || []).map((m) => m.team_id);
  let n = 0;
  for (const tid of teamIds) {
    const casos = await denunciaStore.listarEquipa(tid);
    n += casos.filter((c) => c.reporter_id === userId && c.resolvido_em).length;
  }
  return { total: n }; // só a contagem — nunca o veredicto
}

// ─── GET /api/teams/:slug/votacao-status ──────────────────────────────────────
async function obterVotacaoStatus(slug, userId) {
  const { team } = await requireTeamMember(slug, userId);

  const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
  const total = (membros || []).filter((m) => m.user_id !== userId).length;

  const { data: meus } = await supabase.from('votes').select('para_user_id, updated_at').eq('team_id', team.id).eq('de_user_id', userId);
  const votados = new Set((meus || []).map((v) => v.para_user_id)).size;

  const { data: teamRow } = await supabase.from('teams').select('revotar_pedido_em').eq('id', team.id).maybeSingle();
  const pedidoEm = teamRow?.revotar_pedido_em ? new Date(teamRow.revotar_pedido_em).getTime() : 0;
  const maxUpdated = (meus || []).reduce((mx, v) => Math.max(mx, v.updated_at ? new Date(v.updated_at).getTime() : 0), 0);
  const pedido_revotacao = pedidoEm > 0 && pedidoEm > maxUpdated;

  return { total, votados, faltam: Math.max(0, total - votados), pedido_revotacao };
}

// ─── GET /api/equipas/:slug/campeonato ────────────────────────────────────────
async function obterCampeonato(slug, userId) {
  const team = await getTeamBySlug(slug, 'id, slug');
  if (!team) throw new HttpError(404, 'Time não encontrado.');
  const role = await getRole(team.id, userId);
  if (!role) throw new HttpError(403, 'Não é membro deste time.');

  const { data: campeonato } = await supabase
    .from('campeonatos')
    .select('*')
    .eq('team_id', team.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!campeonato) return { campeonato: null };

  const { data: jornadas } = await supabase
    .from('campeonato_jornadas')
    .select('*')
    .eq('campeonato_id', campeonato.id)
    .order('numero', { ascending: true });

  return { campeonato, jornadas: jornadas || [] };
}

// ─── GET /api/jogos/:gameId/rsvp ──────────────────────────────────────────────
async function obterRsvp(gameId, userId) {
  const game = await loadGame(gameId);
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');
  const role = await getRole(game.teams.id, userId);
  if (!role) throw new HttpError(403, 'Não é membro deste time.');

  const { data: membros } = await supabase
    .from('team_members')
    .select('users ( id, nome, nome_jogador, avatar_url, avatar_generico )')
    .eq('team_id', game.teams.id);
  const users = (membros || []).map((m) => m.users).filter(Boolean);

  const { data: respostas } = await supabase.from('rsvp_respostas').select('user_id, status').eq('game_id', game.id);
  const statusPorUser = {};
  (respostas || []).forEach((r) => {
    statusPorUser[r.user_id] = r.status;
  });

  const confirmados = users.filter((u) => statusPorUser[u.id] === 'confirmado');
  const max = game.max_jogadores ?? null;
  const lugaresDisponiveis = max != null ? Math.max(0, max - confirmados.length) : null;

  const userById = {};
  for (const u of users) userById[u.id] = u;
  const { data: filaRows } = await supabase
    .from('rsvp_espera')
    .select('user_id, posicao')
    .eq('game_id', game.id)
    .order('posicao', { ascending: true });
  const espera = (filaRows || []).map((r) => {
    const u = userById[r.user_id] || {};
    return { user_id: r.user_id, nome: u.nome_jogador || u.nome || null, avatar_url: u.avatar_url || null, posicao: r.posicao };
  });
  const minhaEspera = (filaRows || []).find((r) => r.user_id === userId);

  return {
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

async function obterAd(pagina, userId) {
  const store = await gabineteStore.ler();
  if (store.ads_ativo === false) return { ad: null }; // interruptor geral OFF
  if (!store.toggles || store.toggles[pagina] !== true) return { ad: null }; // página OFF

  let adulto = false;
  if (userId) {
    const { data: u } = await supabase.from('users').select('birthdate').eq('id', userId).maybeSingle();
    adulto = ehAdulto(u && u.birthdate);
  }
  const hoje = hojeStr();
  const elegiveis = (store.campanhas || []).filter(
    (c) => Array.isArray(c.paginas) && c.paginas.includes(pagina) && campanhaAtiva(c, hoje) && podeVerCampanha(c, adulto),
  );
  if (!elegiveis.length) return { ad: null };
  const c = elegiveis[Math.floor(Date.now() / 60000) % elegiveis.length];
  return {
    ad: {
      id: c.id, anunciante: c.anunciante || '', imagem_url: c.imagem_url || null,
      texto: c.texto || c.nome || '', sub: c.sub || c.anunciante || '', cta: c.cta || 'Ver', link: c.link || null,
    },
  };
}

module.exports = {
  obterMe,
  obterTeams,
  obterConvites,
  obterPedidos,
  obterVotacoesPendentes,
  obterDesfechosDenuncias,
  obterVotacaoStatus,
  obterCampeonato,
  obterRsvp,
  obterAd,
  marcarFigurinhaStatus,
};
