// Futty v2.0 — Os membros do time: lista, posição, joga/só organiza, ausência, ativo, sair, remover e editar. Montadas por routes/teams.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, requireTeamMember } = require('../utils/db');
const { agregadosDaEquipa } = require('../utils/agregados');
const { colunaDaNota, notaDoVoto, mediaDasNotas } = require('../utils/notaDoVoto');
const selosCache = require('../utils/selosCache');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const { idsQueSoOrganizam } = require('../utils/soOrganiza');
const { jogosDeFundadorDoTime, comPresencaDeFundador, presencasPorPessoa } = require('../utils/presencaDeFundador');
const { idsDosJogosQueAconteceram } = require('../utils/jogoAconteceu'); // presença só conta depois do horário do jogo

const router = express.Router();

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

    // Estas 4 leituras só dependem de team.id, nenhuma do resultado das outras — em paralelo; só a busca
    // de presenças (que precisa dos IDs dos "últimos jogos") fica sequencial a seguir.
    const [{ data, error }, { data: votos }, { data: ultimosJogos }, agregados, organizam, { data: todosOsJogos }, jogosFundador] = await Promise.all([
      supabase
        .from('team_members')
        .select('id, role, pode_postar, categoria, visivel_ranking, nota_interna, ausente_proximo, ativo, gols, artilharia, vitorias, destaque, users ( id, nome, nome_jogador, avatar_url, avatar_generico, email )')
        .eq('team_id', team.id),
      // Nota média exibida (0 a 10): média dos votos recebidos no time, com o
      // mesmo cálculo do ranking. Requer >= 3 votos, senão fica null.
      supabase.from('votes').select(`para_user_id, ${await colunaDaNota()}`).eq('team_id', team.id),
      // Últimos 5 jogos que já começaram (mais recente → mais antigo) para o histórico de presenças. Um jogador esteve presente se tem
      // game_players.confirmado; jogo que ainda não aconteceu fica fora (confirmar é "vou", não "fui").
      supabase.from('games').select('id, data, created_at').eq('team_id', team.id).lte('data', new Date().toISOString()).order('data', { ascending: false }).limit(5),
      // Agregados VIVOS (mesma fonte/critério do ranking — uma só verdade).
      agregadosDaEquipa(team.id),
      idsQueSoOrganizam(team.id),
      // Todos os jogos, para contar as PRESENÇAS de cada um (a aba Estatísticas do admin).
      supabase.from('games').select('id, data, status, cancelado').eq('team_id', team.id),
      jogosDeFundadorDoTime(team.id), // presença de fundador: a mesma conta do ranking
    ]);
    if (error) throw new HttpError(500, error.message);
    const { golsMap, vitoriasMap, artilhariaMap, destaquesMap } = agregados;
    // Quem joga (não só organiza) ganha a presença de fundador — os mesmos números do ranking.
    const jogamIds = (data || []).map((m) => m.users?.id).filter((id) => id && !organizam.has(id));

    // Presenças = jogos em que a pessoa ESTEVE: confirmada num jogo já encerrado e não cancelado (a mesma conta do perfil do
    // jogador). Antes a seção "Presença" das Estatísticas listava vitórias.
    const idsEncerrados = idsDosJogosQueAconteceram(todosOsJogos);
    let presencasTotais = {}; // user_id -> n de jogos
    if (idsEncerrados.length) {
      const { data: confirmadas } = await supabase.from('game_players').select('game_id, user_id').in('game_id', idsEncerrados).eq('confirmado', true);
      const encerrados = new Set(idsEncerrados);
      const linhas = (confirmadas || []).map((gp) => ({ ...gp, confirmado: true }));
      presencasTotais = presencasPorPessoa(comPresencaDeFundador(linhas, jogosFundador.filter((id) => encerrados.has(id)), jogamIds));
    }

    const MIN_VOTOS = 3;
    const votosAgg = {}; // user_id -> { sum, count }
    for (const v of votos || []) {
      const a = (votosAgg[v.para_user_id] = votosAgg[v.para_user_id] || { sum: 0, count: 0 });
      a.sum += notaDoVoto(v) ?? 0;
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
      const daLista = new Set(jogos.map((g) => g.id));
      for (const gp of comPresencaDeFundador(gps || [], jogosFundador.filter((id) => daLista.has(id)), jogamIds)) {
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
      const notaMedia = va && va.count >= MIN_VOTOS ? mediaDasNotas(va.sum, va.count) : null;
      return {
        id: m.id,
        user_id: uid,
        role: m.role,
        pode_postar: !!m.pode_postar,
        categoria: m.categoria || 'linha',
        // Uma só flag — categoria manda. `goleiro` é o campo; `posicao` sai calculado dela, só por
        // compatibilidade com o app já instalado (nunca é lido da coluna `posicao`).
        goleiro: m.categoria === 'GR',
        posicao: m.categoria === 'GR' ? 'GL' : null,
        ausente_proximo: !!m.ausente_proximo,
        ativo: m.ativo !== false,
        joga: !organizam.has(uid), // false = só organiza o time
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
        presencas: presencasTotais[uid] || 0, // jogos em que a pessoa esteve (todos os encerrados)
        presencas_recentes: presencas,
        taxa_presenca: presencas.length ? `${presentes}/${presencas.length}` : null,
        nota_media: notaMedia,
        // SPEC-FIGURINHA-3: `plan` não significa algo pago — o selo do admin é ter a Brilhante:
        // o avatar ser uma figurinha NOSSA (utils/figurinhaRegra.js, a regra única; a desigualdade
        // avatar_url ≠ foto_url não serve: contava a foto do Google como figurinha).
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
 * app já instalado: { posicao: 'GL'|null }).
 *
 * Decisão do dono: só existe goleiro ou jogador de linha.
 * Esta rota GRAVA `categoria` (não `posicao`) — era a mesma decisão em duas colunas (esta e a que já
 * mandava no ranking); o dono escolheu ficar só com `categoria`. A rota/campo do admin
 * (PATCH /api/teams/:slug/membros/:userId com `categoria`) grava a mesma coluna — as duas nunca
 * podem discordar.
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
 * PATCH /api/equipas/:slug/membros/joga — "Eu jogo" / "Só organizo o time" (migração 067). A pessoa muda o
 * SEU papel (nunca o de outra). Só quem administra o time pode ficar só organizando (`joga: false`);
 * voltar a jogar é de qualquer um. Quem só organiza administra tudo, mas não entra na presença, no
 * sorteio, no ranking nem no pacote.
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
 * Registrado ANTES de /membros/:userId para o "ausencia" não cair no :userId.
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
 * ativo/inativo. Inativos ficam no histórico mas saem do sorteio e ranking.
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

// "me" vem ANTES de ":userId": no Express a primeira rota que casa ganha, e com ":userId" na frente o "me" virava um id
// (um membro comum levava 403 "só admins" ao tentar sair do time).
/**
 * DELETE /api/teams/:slug/membros/me — SAIR do time pelo próprio (SPEC-EQUIPAS).
 * História preservada (mesmo efeito da remoção pelo admin: o passado fica; sai do
 * ranking e do futuro). Guardas: último admin não sai sem passar o cargo; sozinho
 * no time → arquivar é vaga futura (recusa com mensagem clara).
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

module.exports = router;
