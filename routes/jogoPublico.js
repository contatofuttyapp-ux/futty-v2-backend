// Futty v2.0 — O sorteio compartilhado: o código do link curto (/s/<código>), a resolução do código e a página pública do jogo
// (/p/:gameId, sem login). Montadas por routes/games.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError, foraDoTime } = require('../utils/http');
const { supabase, getRole, loadGame } = require('../utils/db');
const { aplicarRostoPublico } = require('../utils/rostoPublico');
const { comAvataresAtuais } = require('../utils/avataresDoSorteio');
const { nomePublico, mapaDeNomesPublicos, comNomesPublicos } = require('../utils/nomePublico');
const { fusoDoTime } = require('../utils/fuso');
const { codigoDoSorteio, jogoDoCodigo } = require('../utils/sorteioCodigo'); // o link curto /s/<código>
const { registroPublico } = require('../utils/registroDoSorteio');

const router = express.Router();

/**
 * POST /api/games/:id/link-curto — o código do link curto do sorteio (futtyapp.com.br/s/<código>), criado na primeira vez.
 * Qualquer membro do time (quem compartilha o sorteio no grupo). { codigo } — null sem a migração 078: o app manda o link longo.
 */
router.post(
  '/api/games/:id/link-curto',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.team_id, req.user.id);
    if (!role) throw foraDoTime();
    res.json({ codigo: await codigoDoSorteio(supabase, game.id) });
  })
);

/**
 * GET /api/s/:codigo — para onde o link curto do sorteio leva: { slug, gameId } (sem login, como a vista pública /api/p/).
 * O app troca /s/<código> por /p/<slug>/<id>, a página de sempre. Código inexistente (ou sem a 078) = 404.
 */
router.get(
  '/api/s/:codigo',
  asyncHandler(async (req, res) => {
    const gameId = await jogoDoCodigo(supabase, req.params.codigo);
    const game = gameId ? await loadGame(gameId) : null;
    if (!game || !game.teams) throw new HttpError(404, 'Esse sorteio não existe.');
    res.json({ slug: game.teams.slug, gameId: game.id });
  })
);

/**
 * GET /api/p/:gameId — vista pública do sorteio (sem auth, para partilha/telão).
 * Devolve só o essencial: nome do time, times do sorteio e o resultado.
 */
router.get(
  '/api/p/:gameId',
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.gameId);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    let gols = [];
    if (game.resultado_nivel === 3) {
      const { data } = await supabase
        .from('gols_jogadores')
        .select('user_id, gols, users ( nome, nome_jogador )')
        .eq('game_id', game.id);
      // O apelido, não o nome completo: quem recebe o link não é do time.
      gols = (data || []).map((g) => ({ user_id: g.user_id, gols: g.gols || 0, nome: g.users ? nomePublico(g.users) : null }));
    }

    // PRIVACIDADE /p/ (Opção B): decide POR JOGADOR se o rosto entra — adulto E
    // consentimento → URL do proxy público; senão silhueta (fail-closed). O snapshot
    // times_resultado só tem user_id/avatar_url, por isso juntamos os donos aqui.
    if (game.times_resultado) {
      const ids = new Set();
      const colher = (j) => { if (j && j.user_id) ids.add(j.user_id); };
      (game.times_resultado.times || []).forEach((t) => (t.jogadores || []).forEach(colher));
      (game.times_resultado.reservas || []).forEach(colher);
      const original = game.times_resultado.registro?.original;
      (original?.times || []).forEach((t) => (t.jogadores || []).forEach(colher));
      (original?.reservas || []).forEach(colher);
      // Quem sorteou/ajustou também aparece no selo do registro: os nomes deles seguem a mesma regra do apelido.
      const reg = game.times_resultado.registro;
      [reg?.por, ...((reg?.ajustes) || []).map((a) => a?.por)].forEach((p) => { if (p && p.id) ids.add(p.id); });
      const usersById = new Map();
      if (ids.size) {
        // Se a coluna mostrar_rosto_publico ainda não existir (DDL por correr), a query
        // devolve erro → mapa vazio → TODOS caem em silhueta (fail-closed, seguro).
        const { data: donos } = await supabase
          .from('users')
          .select('id, nome, nome_jogador, birthdate, mostrar_rosto_publico, avatar_url')
          .in('id', [...ids]);
        (donos || []).forEach((u) => usersById.set(u.id, u));
      }
      // A foto de hoje, não a de quando o sorteio foi feito (utils/avataresDoSorteio.js); a regra de
      // privacidade abaixo decide depois se ela pode aparecer.
      game.times_resultado = comAvataresAtuais(game.times_resultado, new Map([...usersById].map(([id, u]) => [id, u.avatar_url || null])));
      // O apelido de hoje, nunca o nome completo (utils/nomePublico.js): o snapshot guarda o nome de quando o sorteio foi feito.
      const nomesPublicos = mapaDeNomesPublicos([...usersById.values()]);
      game.times_resultado = comNomesPublicos(game.times_resultado, nomesPublicos);
      aplicarRostoPublico(game.times_resultado, usersById, `${req.protocol}://${req.get('host')}`);
      if (game.times_resultado.registro) game.times_resultado = { ...game.times_resultado, registro: registroPublico(game.times_resultado.registro, nomesPublicos) };
    }

    res.json({
      // logo_url: a prévia do link (functions/_shared/previaDoLink.js) usa o
      // logo do time como og:image quando existe — "o mínimo" para a prévia parar de ser genérica.
      // cidade: o rabicho do fuso ("horário de São Paulo") precisa dela.
      // cor: o resultado já montado (DrawnTeams) pinta o cabeçalho de cada time com ela.
      equipa: { nome: game.teams.nome, slug: game.teams.slug, cor: game.teams.cor || null, fuso: fusoDoTime(game.teams), cidade: game.teams.cidade || null, logo_url: game.teams.logo_url || null },
      // jogo: quando e onde — a informação que quem recebe o link no grupo foi mesmo procurar,
      // além do time e dos times sorteados.
      jogo: { data: game.data || null, local: game.local || null },
      times_resultado: game.times_resultado || null,
      resultado: {
        nivel: game.resultado_nivel || 0,
        time_vencedor: game.time_vencedor || null,
        placar_a: game.placar_a ?? null,
        placar_b: game.placar_b ?? null,
        gols,
      },
    });
  })
);

module.exports = router;
