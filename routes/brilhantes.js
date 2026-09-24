// Futty v2.0 — Figurinhas Brilhantes: estado e pedidos (SPEC-FIGURINHA-3, §4/§7).
//
// Enquanto a compra na loja não existe (dia do dinheiro), o botão de cada
// produto faz uma coisa VERDADEIRA: grava um pedido que o Gabinete vai listar,
// e o super-admin ativa à mão. Nada de "em breve" na tela — a regra da casa.
//
// Depende da migração 054. Sem ela, `GET /api/brilhantes/estado` responde com
// tudo a zero (ninguém tem direito, nenhum pedido) e o POST devolve um 503
// digno — o app continua de pé e ninguém fica a achar que pediu quando não
// pediu.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const { temDireito, ehMigracaoEmFalta } = require('../utils/direitoBrilhante');

const router = express.Router();

const PRODUTOS = ['pacote', 'manto', 'minha'];
// Vazio do team_id no índice único parcial da 054 (NULL não colide com NULL).
const SEM_TIME = '00000000-0000-0000-0000-000000000000';

/** Pedidos vivos da pessoa: as pendentes de sempre + as recusas recentes. */
async function lerPedidos(userId, desdeISO, comMotivo) {
  const { data, error } = await supabase
    .from('pedidos_ativacao')
    .select(`id, team_id, produto, estado, criado_em, resolvido_em${comMotivo ? ', motivo' : ''}`)
    .eq('user_id', userId)
    .in('estado', ['pendente', 'recusado'])
    .or(`estado.eq.pendente,resolvido_em.gte.${desdeISO}`)
    .order('criado_em', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * GET /api/brilhantes/estado — tudo o que as telas precisam saber numa vez:
 * o direito atual, os créditos, os times onde a pessoa é dona (para oferecer o
 * pacote), os times com pacote ativo e os pedidos que já estão pendentes.
 */
router.get(
  '/api/brilhantes/estado',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const direito = await temDireito(userId);

    let times = [];
    try {
      const { data, error } = await supabase
        .from('team_members')
        .select('role, teams!inner(id, nome, slug, brilhante_ativo, brilhante_kit, brilhante_limite, manto_proprio)')
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
      times = (data || []).map((m) => ({
        id: m.teams.id,
        nome: m.teams.nome,
        slug: m.teams.slug,
        sou_dono: m.role === 'admin',
        brilhante_ativo: !!m.teams.brilhante_ativo,
        brilhante_kit: m.teams.brilhante_kit || null,
        brilhante_limite: Number(m.teams.brilhante_limite) || 25,
        manto_proprio: !!m.teams.manto_proprio,
      }));
    } catch (e) {
      console.warn('[brilhantes] times indisponíveis (migração 054 aplicada?):', e.message);
      if (!ehMigracaoEmFalta(e.message)) throw e;
    }

    // Pendentes E recusados: a tela tem de saber dizer as duas coisas
    // ("a gente ativa e avisa" / o motivo da recusa). Os 'ativado' não vêm —
    // quem foi ativado já tem o direito, e o recado some sozinho, que é o
    // comportamento certo.
    const pedidos = await pedidosVivos(userId);

    res.json({
      direito: { fonte: direito.fonte, team_id: direito.teamId, kit_id: direito.kitId, restantes: direito.restantes },
      creditos: direito.creditos,
      times,
      pedidos,
    });
  }),
);

/**
 * POST /api/brilhantes/pedido { produto, teamId? } — grava o pedido.
 * Uma pendente por pessoa/produto/time (índice único parcial da 054): pedir
 * duas vezes devolve o pedido que já existe, em vez de um erro — do lado de
 * quem toca no botão, pedir de novo não é um erro, é impaciência.
 */
router.post(
  '/api/brilhantes/pedido',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const produto = String(req.body?.produto || '');
    if (!PRODUTOS.includes(produto)) throw new HttpError(400, 'Produto inválido.');

    // 'pacote' e 'manto' são do time e só o dono pede; 'minha' é da pessoa.
    let teamId = null;
    if (produto === 'pacote' || produto === 'manto') {
      teamId = req.body?.teamId ? String(req.body.teamId) : null;
      if (!teamId) throw new HttpError(400, 'Escolha o time.');
      const { data: membro, error } = await supabase
        .from('team_members')
        .select('role')
        .eq('team_id', teamId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new HttpError(500, error.message);
      if (membro?.role !== 'admin') throw new HttpError(403, 'Só quem criou o time pode pedir isto.');
    }

    try {
      const { data, error } = await supabase
        .from('pedidos_ativacao')
        .insert({ user_id: userId, team_id: teamId, produto })
        .select('id, team_id, produto, estado, criado_em')
        .single();
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      console.log('[brilhantes] pedido criado', { userId, produto, teamId });
      return res.status(201).json({ pedido: data, ja_existia: false });
    } catch (e) {
      // 23505 = o índice único parcial disparou: já há uma pendente igual.
      if (e.code === '23505') {
        const { data } = await supabase
          .from('pedidos_ativacao')
          .select('id, team_id, produto, estado, criado_em')
          .eq('user_id', userId)
          .eq('produto', produto)
          .eq('estado', 'pendente')
          .or(teamId ? `team_id.eq.${teamId}` : `team_id.is.null,team_id.eq.${SEM_TIME}`)
          .maybeSingle();
        return res.json({ pedido: data || null, ja_existia: true });
      }
      if (ehMigracaoEmFalta(e.message)) {
        console.warn('[brilhantes] pedido não gravado (migração 054 aplicada?):', e.message);
        throw new HttpError(503, 'Ainda não dá para pedir a ativação. Tente de novo mais tarde.', 'BRILHANTE_INDISPONIVEL');
      }
      throw new HttpError(500, e.message);
    }
  }),
);

/**
 * Os pedidos vivos da pessoa, já com o fail-safe das migrações em falta.
 * O Início usa isto para o recado do pedido (pendente/recusado) sem ter de
 * repetir a query nem o tratamento de erro. Nunca lança: sem as migrações,
 * devolve lista vazia e a tela simplesmente não mostra recado nenhum.
 */
async function pedidosVivos(userId, dias = 30) {
  const desdeISO = new Date(Date.now() - dias * 86400000).toISOString();
  try {
    return await lerPedidos(userId, desdeISO, true);
  } catch (e) {
    if (/motivo/i.test(e.message)) {
      try { return await lerPedidos(userId, desdeISO, false); } catch { return []; }
    }
    if (!ehMigracaoEmFalta(e.message)) console.warn('[brilhantes] pedidos vivos:', e.message);
    return [];
  }
}

router.pedidosVivos = pedidosVivos;
module.exports = router;
