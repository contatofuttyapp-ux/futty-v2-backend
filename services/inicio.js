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
const { temFigurinhaIA, avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const gabineteStore = require('../utils/gabineteStore');
const denunciaStore = require('../utils/denunciaStore');
const { criarCache } = require('../utils/cacheQuente');

// ─── GET /api/me ──────────────────────────────────────────────────────────────
const PERFIL_COLS_BASE =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo, mostrar_rosto_publico, avatar_generico';
// figurinha_status/_em (migração 051) — colunas novas; ver resiliência em
// obterPerfilResiliente() abaixo (mesmo padrão de `historico` em games.js).
const PERFIL_COLS_FIGURINHA = `${PERFIL_COLS_BASE}, figurinha_status, figurinha_status_em`;
// foto_original_url (migração 057, Rodada 19) — "Ajustar enquadramento" (Figurinha.jsx)
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
    // RODADA 20 — tem_figurinha (abaixo): existência basta, .limit(1). r.data
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

  // RODADA 20 — achado da Rodada 19: kit_ativo||'dark-gold' (linha abaixo,
  // antes desta correção) fazia toda conta nova parecer "já tem figurinha"
  // pro frontend (Figurinha.jsx usava !!kit_ativo). tem_figurinha agora é
  // calculado aqui, na fonte, e cobre os 3 sinais reais de "já gerou
  // alguma": um slot pago (brilhantes_time), uma no histórico
  // (user_avatar_historico, migração 057) ou o avatar ATUAL ser um arquivo
  // de figurinha nosso (cobre quem gerou antes da 057 existir e nunca tem
  // linha no histórico). HOTFIX 26 (25-set): o 3º sinal era `avatar_url ≠
  // foto_url` + status 'pronta', e a foto do Google copiada pelo trigger
  // handle_new_user contava como figurinha; agora olha o NOME do arquivo
  // (utils/figurinhaRegra.js), a mesma regra do upload de foto.
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
      // RODADA 28 — o card mostra AGORA uma figurinha nossa (arquivo -ai- no bucket), pela regra única
      // (utils/figurinhaRegra.js). As telas decidiam isto por foto_url ≠ avatar_url — a regra que o
      // Hotfix 26 aposentou no motor: com a foto do Google em avatar_url, a foto da pessoa ia para o
      // card como se fosse figurinha (seletor de fundos, zoom abaixo da moldura, faixas vazias).
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

// ─── GET /api/teams ───────────────────────────────────────────────────────────
async function obterTeams(userId) {
  const { data, error } = await supabase
    .from('team_members')
    // VELOCIDADE 9: as quatro colunas do pacote de figurinhas entram no MESMO
    // select (não há ida nova). É o que faltava para a Figurinha se abrir a
    // partir do que o /api/inicio já trouxe, em vez de pedir
    // /api/brilhantes/estado só para saber se o time tem pacote — 606 ms de
    // Lisboa, no relatório do dono, por um botão.
    .select('role, teams ( id, nome, slug, cor, criado_por, created_at, logo_url, cor_fundo, modo_visibilidade, brilhante_ativo, brilhante_kit, brilhante_limite, manto_proprio )')
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
// VELOCIDADE 6A (15-set): eram 3 idas EM SÉRIE (team_members → games →
// game_players). As presenças passam a vir embutidas nos jogos (select do
// PostgREST), o que junta as duas últimas: ficam 2.
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
    .select('id, team_id, data, local, status, sorteio_realizado, cancelado, game_players ( user_id, confirmado )')
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
// VELOCIDADE 6A (15-set): eram 4 idas EM SÉRIE — team_members → (teams, votes,
// games) → as minhas presenças → as presenças dos colegas. Ficam 2:
//   · os dados das equipas vêm embutidos no team_members (mata a query `teams`);
//   · as presenças vêm embutidas nos jogos, e as minhas e as dos colegas saem
//     do mesmo conjunto (matam as duas idas a game_players).
async function obterVotacoesPendentes(userId) {
  const { data: minhas } = await supabase
    .from('team_members')
    .select('team_id, teams ( id, slug, nome, revotar_pedido_em )')
    .eq('user_id', userId);
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

async function obterDesfechosDenuncias(userId) {
  const { data: membros } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
  const teamIds = (membros || []).map((m) => m.team_id);
  // Velocidade 2 (12-set): era um `for` sequencial (1 download de Storage por
  // equipa, em série) — agora todas as equipas em paralelo (e quase sempre em cache).
  const porEquipa = await Promise.all(teamIds.map((tid) => casosDaEquipaComCache(tid)));
  const n = porEquipa.reduce((total, casos) => total + casos.filter((c) => c.reporter_id === userId && c.resolvido_em).length, 0);
  return { total: n }; // só a contagem — nunca o veredicto
}

// ─── GET /api/teams/:slug/votacao-status ──────────────────────────────────────
// `conhecido` (Velocidade 6A, 15-set): quando o chamador já sabe o time e o
// papel — o /api/inicio sabe, veio do obterTeams — salta o requireTeamMember,
// que é mais uma ida ao banco para confirmar o que já se sabe. A rota solta
// continua a chamar sem ele e a validar como sempre.
async function obterVotacaoStatus(slug, userId, conhecido = null) {
  const team = conhecido?.id && conhecido?.role ? conhecido : (await requireTeamMember(slug, userId)).team;

  // Independentes entre si depois de `team` resolvido (13-set, "Velocidade
  // 3": eram 3 awaits em série).
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

// ─── GET /api/equipas/:slug/campeonato ────────────────────────────────────────
// `conhecido` (Velocidade 6A, 15-set): o /api/inicio já tem o time e o papel do
// obterTeams — passá-los aqui poupa o getTeamBySlug E o getRole, duas idas ao
// banco só para reconfirmar o que já veio. A rota solta continua a validar.
async function obterCampeonato(slug, userId, conhecido = null) {
  const jaSabido = conhecido?.id && conhecido?.role ? conhecido : null;
  const team = jaSabido || (await getTeamBySlug(slug, 'id, slug'));
  if (!team) throw new HttpError(404, 'Time não encontrado.');

  // role e campeonato só dependem de team.id, não um do outro (13-set,
  // "Velocidade 3": eram sequenciais). O acesso só é confirmado depois —
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
async function obterRsvp(gameId, userId) {
  const game = await loadGame(gameId);
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');

  // role, membros, respostas e filaRows só dependem de game/team já
  // carregados — nenhum depende dos outros 3 (13-set, "Velocidade 3": eram 4
  // awaits em série). O acesso só é confirmado depois — se `role` vier vazio
  // o resto é descartado a seguir.
  const [role, { data: membros }, { data: respostas }, { data: filaRows }] = await Promise.all([
    getRole(game.teams.id, userId),
    supabase.from('team_members').select('users ( id, nome, nome_jogador, avatar_url, avatar_generico )').eq('team_id', game.teams.id),
    supabase.from('rsvp_respostas').select('user_id, status').eq('game_id', game.id),
    supabase.from('rsvp_espera').select('user_id, posicao').eq('game_id', game.id).order('posicao', { ascending: true }),
  ]);
  if (!role) throw new HttpError(403, 'Não é membro deste time.');

  const users = (membros || []).map((m) => m.users).filter(Boolean);
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

// PUBLICIDADE EM TODOS OS PLANOS (15-set, decisão do dono): Pro/Elite deixam de
// ficar isentos de anúncio — passam a ver METADE das oportunidades elegíveis,
// nunca zero (o Free continua a ver todas). Hash simples e determinístico de
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
 * idade e o plano de quem pede. Lido UMA vez (VELOCIDADE 9) — antes, servir as
 * cinco páginas de uma sessão fazia cinco leituras iguais à tabela `users`.
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
 * TODOS os slots de uma sessão numa resposta (VELOCIDADE 9).
 *
 * O relatório do build 28 mostrou 4 `GET /api/ads?pagina=…` (~500 ms cada, de
 * Lisboa) + 3 `POST /api/ads/evento` num percurso de 20 segundos: 7 dos 22
 * pedidos da sessão eram publicidade — mais do que qualquer tela. E o trabalho
 * de servidor era ~0 ms: o custo era só a distância, repetida por tela.
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
  obterAdsSessao,
  marcarFigurinhaStatus,
};
