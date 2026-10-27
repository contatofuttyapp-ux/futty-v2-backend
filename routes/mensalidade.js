// Futty v2.0 — A mensalidade do time ("pagou / não pagou"). O app NÃO mexe em dinheiro: o admin escreve o jeito de pagar (um link
// ou um texto), o jogador avisa "Já paguei" e o admin confirma. Sem registro no mês = em aberto (o mês novo começa assim, sem job).
//
//   GET    /api/teams/:slug/mensalidade?mes=AAAA-MM            membro: a configuração, o mês e o status (o dele; a lista só p/ admin
//                                                            ou com "mostrar a lista para o time" ligado)
//   PUT    /api/teams/:slug/mensalidade/ajustes                 admin: liga/desliga e configura
//   PUT    /api/teams/:slug/mensalidade/:mes/membros/:userId   admin: { status: 'pago' | 'aberto' } (o mês atual e os 2 anteriores)
//   POST   /api/teams/:slug/mensalidade/:mes/ja-paguei         membro: "Já paguei" → 'avisou' (e os admins recebem um push)
//   DELETE /api/teams/:slug/mensalidade/:mes/ja-paguei         membro: desfaz o aviso enquanto o admin não confirmou
//   POST   /api/teams/:slug/historico/interesse                membro: tocou em "Traga seu histórico" (para medir a demanda)
//   POST   /api/interno/mensalidade/lembretes                  agendador: manda os lembretes do vencimento (segredo interno)
//
// Sem a migração 088 o time segue igual: a mensalidade aparece desligada e indisponível, e configurar responde 503.
const express = require('express');
const { supabase, getTeamBySlug, getRole } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { HttpError, asyncHandler, foraDoTime } = require('../utils/http');
const m = require('../utils/mensalidade');
const lembretes = require('../utils/lembretesMensalidade');
const tarefasPintura = require('../utils/tarefasPintura');

// Dentro do time a regra é a das telas (frontend/src/utils/nomeExibicao.js): apelido → nome → "Jogador".
const nomeExibicao = (u) => String(u?.nome_jogador || '').trim() || String(u?.nome || '').trim() || 'Jogador';

const CONFIG_PADRAO = { ativa: false, valor: null, dia_vencimento: null, como_pagar: null, lista_publica: false, lembrete: true };
const ORIGENS_DO_HISTORICO = ['criar_time', 'ranking', 'resenha'];

const faltaAMigracao = (erro) => !!erro && /mensalidade|historico_interesse/i.test(erro.message || '') && /does not exist|schema cache/i.test(erro.message || '');
const migracaoPendente = () => new HttpError(503, 'A mensalidade ainda não está disponível. Tente de novo mais tarde.', 'MENSALIDADE_INDISPONIVEL');

/** O time (com o fuso e a data em que nasceu) e o papel de quem pede. Quem não é do time: 403 com o código da casa. */
async function timeEPapel(slug, userId) {
  const team = await getTeamBySlug(slug, 'id, nome, slug, created_at');
  if (!team) throw new HttpError(404, 'Time não encontrado.');
  const role = await getRole(team.id, userId);
  if (!role) throw foraDoTime();
  return { team, role };
}

async function lerConfig(teamId) {
  const { data, error } = await supabase.from('team_mensalidade').select('ativa, valor, dia_vencimento, como_pagar, lista_publica, lembrete').eq('team_id', teamId).maybeSingle();
  if (error) {
    if (faltaAMigracao(error)) return { config: { ...CONFIG_PADRAO }, disponivel: false };
    throw new HttpError(500, error.message);
  }
  return { config: { ...CONFIG_PADRAO, ...(data || {}) }, disponivel: true };
}

/** O que o jogador vê da configuração (o lembrete é coisa do admin). */
const configDoJogador = ({ ativa, valor, dia_vencimento: dia, como_pagar: como, lista_publica: lista }) => ({ ativa, valor, dia_vencimento: dia, como_pagar: como, lista_publica: lista });

async function membrosDoTime(teamId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, role, users ( id, nome, nome_jogador, avatar_url, avatar_generico )')
    .eq('team_id', teamId);
  if (error) throw new HttpError(500, error.message);
  return (data || []).filter((x) => x.users).map((x) => ({
    user_id: x.user_id, role: x.role, nome: x.users.nome || null, nome_jogador: x.users.nome_jogador || null,
    avatar_url: x.users.avatar_url || null, avatar_generico: x.users.avatar_generico || null,
  }));
}

async function registrosDoMes(teamId, mes) {
  const { data, error } = await supabase.from('mensalidade_pagamentos').select('user_id, status, marcado_por, marcado_em').eq('team_id', teamId).eq('mes', m.dataDoMes(mes));
  if (error) throw new HttpError(500, error.message);
  return new Map((data || []).map((r) => [r.user_id, r]));
}

/** Mês da URL de uma ação: tem de ser um mês que o admin ainda corrige (o atual e os 2 anteriores). */
function mesDaAcao(param, team) {
  const atual = m.mesNoFuso(new Date(), team.fuso);
  if (!m.mesEditavel(param, atual)) throw new HttpError(403, 'Esse mês já fechou: dá só para ver.', 'MES_FECHADO');
  return param;
}

async function exigirLigada(teamId) {
  const { config, disponivel } = await lerConfig(teamId);
  if (!disponivel) throw migracaoPendente();
  if (!config.ativa) throw new HttpError(409, 'A mensalidade deste time está desligada.', 'MENSALIDADE_DESLIGADA');
  return config;
}

function criarRotasDaMensalidade({ avisar = (...a) => require('./push').enviarNotificacao(...a) } = {}) {
  const router = express.Router();

  router.get(
    '/api/teams/:slug/mensalidade',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team, role } = await timeEPapel(req.params.slug, req.user.id);
      const souAdmin = role === 'admin';
      const { config, disponivel } = await lerConfig(team.id);
      const atual = m.mesNoFuso(new Date(), team.fuso);
      const base = { disponivel, sou_admin: souAdmin, config: souAdmin ? config : configDoJogador(config), mes_atual: atual };
      if (!config.ativa) return res.json({ ...base, ativa: false });

      const primeiro = m.primeiroMes(atual, team.created_at, team.fuso);
      const mes = m.mesPedido(req.query.mes, atual, primeiro);
      const [membros, registros] = await Promise.all([membrosDoTime(team.id), registrosDoMes(team.id, mes)]);
      const linhas = membros
        .map((x) => {
          const r = registros.get(x.user_id);
          return { ...x, status: r?.status || 'aberto', marcado_em: r?.marcado_em || null };
        })
        .sort((a, b) => nomeExibicao(a).localeCompare(nomeExibicao(b), 'pt-BR'));
      const eu = linhas.find((x) => x.user_id === req.user.id);
      const veLista = souAdmin || config.lista_publica;
      res.json({
        ...base,
        ativa: true,
        mes,
        primeiro_mes: primeiro,
        editavel: m.mesEditavel(mes, atual),
        vencimento: m.vencimentoDoMes(mes, config.dia_vencimento),
        eu: { status: eu?.status || 'aberto', marcado_em: eu?.marcado_em || null },
        lista: veLista ? linhas : null,
        contador: veLista ? { pagos: linhas.filter((x) => x.status === 'pago').length, avisaram: linhas.filter((x) => x.status === 'avisou').length, total: linhas.length } : null,
      });
    })
  );

  router.put(
    '/api/teams/:slug/mensalidade/ajustes',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team, role } = await timeEPapel(req.params.slug, req.user.id);
      if (role !== 'admin') throw new HttpError(403, 'Só o admin configura a mensalidade.');
      const { mudancas, erro } = m.configDoPedido(req.body);
      if (erro) throw new HttpError(400, erro);
      const { config: antes, disponivel } = await lerConfig(team.id);
      if (!disponivel) throw migracaoPendente();
      const nova = { ...antes, ...mudancas };
      const { error } = await supabase
        .from('team_mensalidade')
        .upsert({ team_id: team.id, ...nova, atualizada_em: new Date().toISOString(), atualizada_por: req.user.id }, { onConflict: 'team_id' });
      if (error) throw (faltaAMigracao(error) ? migracaoPendente() : new HttpError(500, error.message));
      res.json({ config: nova });
    })
  );

  router.put(
    '/api/teams/:slug/mensalidade/:mes/membros/:userId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team, role } = await timeEPapel(req.params.slug, req.user.id);
      if (role !== 'admin') throw new HttpError(403, 'Só o admin marca quem pagou.');
      const status = req.body?.status;
      if (status !== 'pago' && status !== 'aberto') throw new HttpError(400, 'Use pago ou em aberto.');
      await exigirLigada(team.id);
      const mes = mesDaAcao(req.params.mes, team);
      const alvo = await getRole(team.id, req.params.userId);
      if (!alvo) throw new HttpError(404, 'Essa pessoa não é do time.');
      const chave = { team_id: team.id, user_id: req.params.userId, mes: m.dataDoMes(mes) };
      if (status === 'pago') {
        const { error } = await supabase
          .from('mensalidade_pagamentos')
          .upsert({ ...chave, status: 'pago', marcado_por: req.user.id, marcado_em: new Date().toISOString() }, { onConflict: 'team_id,user_id,mes' });
        if (error) throw new HttpError(500, error.message);
      } else {
        const { error } = await supabase.from('mensalidade_pagamentos').delete().eq('team_id', chave.team_id).eq('user_id', chave.user_id).eq('mes', chave.mes);
        if (error) throw new HttpError(500, error.message);
      }
      res.json({ mes, user_id: req.params.userId, status });
    })
  );

  router.post(
    '/api/teams/:slug/mensalidade/:mes/ja-paguei',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team } = await timeEPapel(req.params.slug, req.user.id);
      await exigirLigada(team.id);
      const mes = mesDaAcao(req.params.mes, team);
      const atual = (await registrosDoMes(team.id, mes)).get(req.user.id);
      if (atual?.status === 'pago') throw new HttpError(409, 'O admin já marcou o seu pagamento.', 'JA_PAGO');
      if (atual?.status === 'avisou') return res.json({ mes, status: 'avisou' }); // dois toques = um aviso só (e um push só)
      const { error } = await supabase
        .from('mensalidade_pagamentos')
        .upsert({ team_id: team.id, user_id: req.user.id, mes: m.dataDoMes(mes), status: 'avisou', marcado_por: req.user.id, marcado_em: new Date().toISOString() }, { onConflict: 'team_id,user_id,mes', ignoreDuplicates: true });
      if (error) throw new HttpError(500, error.message);

      // O push para os admins (menos quem avisou, se for admin): "Fulano avisou que pagou a mensalidade". Quem desligou os pedidos
      // em Perfil → Notificações não recebe (o aviso é da mesma família dos pedidos de entrada).
      const [{ data: eu }, { data: admins }] = await Promise.all([
        supabase.from('users').select('nome, nome_jogador').eq('id', req.user.id).maybeSingle(),
        supabase.from('team_members').select('user_id').eq('team_id', team.id).eq('role', 'admin'),
      ]);
      const ids = (admins || []).map((a) => a.user_id).filter((id) => id && id !== req.user.id);
      if (ids.length) {
        Promise.resolve(avisar(ids, {
          title: `${nomeExibicao(eu)} avisou que pagou a mensalidade`,
          body: `${team.nome} · ${m.nomeDoMes(mes)}. Confira e marque como pago.`,
          url: `/time/${team.slug}?aba=mensalidade&mes=${mes}`,
        }, { categoria: 'pedidos' })).catch(() => {});
      }
      res.json({ mes, status: 'avisou' });
    })
  );

  router.delete(
    '/api/teams/:slug/mensalidade/:mes/ja-paguei',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team } = await timeEPapel(req.params.slug, req.user.id);
      await exigirLigada(team.id);
      const mes = mesDaAcao(req.params.mes, team);
      const atual = (await registrosDoMes(team.id, mes)).get(req.user.id);
      if (atual?.status === 'pago') throw new HttpError(409, 'O admin já confirmou: só ele pode desfazer.', 'JA_PAGO');
      if (atual?.status === 'avisou') {
        const { error } = await supabase.from('mensalidade_pagamentos').delete()
          .eq('team_id', team.id).eq('user_id', req.user.id).eq('mes', m.dataDoMes(mes)).eq('status', 'avisou');
        if (error) throw new HttpError(500, error.message);
      }
      res.json({ mes, status: 'aberto' });
    })
  );

  router.post(
    '/api/teams/:slug/historico/interesse',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { team } = await timeEPapel(req.params.slug, req.user.id);
      const origem = req.body?.origem;
      if (!ORIGENS_DO_HISTORICO.includes(origem)) throw new HttpError(400, 'Origem inválida.');
      const { error } = await supabase.from('historico_interesse').insert({ team_id: team.id, user_id: req.user.id, origem });
      // Contar o toque nunca pode impedir o e-mail: sem a migração (ou com o banco lento), só fica no log.
      if (error) console.warn('[historico] interesse não gravado:', error.message);
      console.log(`[historico] interesse · ${origem} · ${team.slug}`);
      res.status(204).end();
    })
  );

  // O agendador (Cloud Scheduler, de hora em hora) — mesmo segredo e mesma conta de serviço do Cloud Tasks da pintura.
  router.post(
    '/api/interno/mensalidade/lembretes',
    asyncHandler(async (req, res) => {
      await tarefasPintura.autorizar(req);
      res.json(await lembretes.enviarLembretes({ avisar }));
    })
  );

  return router;
}

module.exports = criarRotasDaMensalidade();
module.exports.criarRotasDaMensalidade = criarRotasDaMensalidade;
