// Futty v2.0 — O lembrete do vencimento da mensalidade: "Mensalidade de outubro do Missa de Quinta em aberto".
//
// Sai no dia do vencimento a partir das 10h do relógio do time (utils/mensalidade.js#mesDoLembrete), para cada membro ainda em
// aberto no mês, no MÁXIMO uma vez por pessoa por mês: a linha em `mensalidade_lembretes` (chave time + pessoa + mês) é gravada
// ANTES do push, e só recebe push quem acabou de ganhar a linha — duas instâncias do motor rodando ao mesmo tempo não mandam dois.
//
// Quem acorda isto: o agendador (Cloud Scheduler → POST /api/interno/mensalidade/lembretes, de hora em hora) e, de carona, o
// /api/inicio (no máximo a cada 10 min por instância). O Cloud Run não roda nada sozinho entre pedidos; com os dois, o lembrete sai
// mesmo antes do agendador ser configurado, desde que alguém abra o app naquele dia.
const { supabase } = require('./db');
const { lerComFuso } = require('./fuso');
const m = require('./mensalidade');

const DE_CARONA_A_CADA_MS = 10 * 60 * 1000;
let ultimaCarona = 0;

const faltaAMigracao = (erro) => !!erro && /mensalidade/i.test(erro.message || '') && /does not exist|schema cache/i.test(erro.message || '');

/**
 * Manda os lembretes que estão na hora. Devolve { times, enviados } (os times com mensalidade e lembrete ligados, e quantos
 * push saíram agora). `avisar` é o enviarNotificacao (routes/push.js): quem desligou os avisos de jogos não recebe.
 */
async function enviarLembretes({ agora = new Date(), avisar = (...a) => require('../routes/push').enviarNotificacao(...a) } = {}) {
  const { data: configs, error } = await supabase
    .from('team_mensalidade')
    .select('team_id, ativa, lembrete, dia_vencimento, valor')
    .eq('ativa', true)
    .eq('lembrete', true);
  if (error) {
    if (faltaAMigracao(error)) return { times: 0, enviados: 0 };
    throw new Error(error.message);
  }
  let enviados = 0;
  const plataforma = require('./plataformaStore'); // eslint-disable-line global-require
  for (const cfg of configs || []) {
    // eslint-disable-next-line no-await-in-loop
    const { data: team } = await lerComFuso((novas) => supabase.from('teams').select(novas ? `id, slug, nome, ${novas}` : 'id, slug, nome').eq('id', cfg.team_id).maybeSingle());
    if (!team) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await plataforma.equipaSuspensa(team.id)) continue;
    const mes = m.mesDoLembrete({ agora, fuso: team.fuso, ...cfg });
    if (!mes) continue;
    const dataMes = m.dataDoMes(mes);
    // eslint-disable-next-line no-await-in-loop
    const [{ data: membros }, { data: registros }, { data: jaAvisados }] = await Promise.all([
      supabase.from('team_members').select('user_id').eq('team_id', team.id),
      supabase.from('mensalidade_pagamentos').select('user_id').eq('team_id', team.id).eq('mes', dataMes),
      supabase.from('mensalidade_lembretes').select('user_id').eq('team_id', team.id).eq('mes', dataMes),
    ]);
    const fora = new Set([...(registros || []), ...(jaAvisados || [])].map((r) => r.user_id));
    const emAberto = [...new Set((membros || []).map((x) => x.user_id))].filter((id) => id && !fora.has(id));
    if (!emAberto.length) continue;
    // ignoreDuplicates: quem outra instância acabou de avisar não volta na resposta, e por isso não recebe outro push.
    // eslint-disable-next-line no-await-in-loop
    const { data: novas, error: erroGravar } = await supabase
      .from('mensalidade_lembretes')
      .upsert(emAberto.map((user_id) => ({ team_id: team.id, user_id, mes: dataMes })), { onConflict: 'team_id,user_id,mes', ignoreDuplicates: true })
      .select('user_id');
    if (erroGravar) {
      console.warn(`[mensalidade] lembretes de ${team.slug} não gravados (nenhum push sai sem a linha):`, erroGravar.message);
      continue;
    }
    const ids = (novas || []).map((r) => r.user_id);
    if (!ids.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await avisar(ids, {
      title: `Mensalidade de ${m.nomeDoMes(mes)} do ${team.nome} em aberto`,
      body: cfg.valor ? `${cfg.valor}. Toque para ver como pagar.` : 'Toque para ver como pagar.',
      url: `/time/${team.slug}?aba=mensalidade`,
    }, { categoria: 'jogos' });
    enviados += ids.length;
    console.log(`[mensalidade] lembrete de ${mes} · ${team.slug} · ${ids.length} pessoa(s)`);
  }
  return { times: (configs || []).length, enviados };
}

/** De carona num pedido do app: no máximo a cada 10 min por instância, sem esperar e sem nunca derrubar o pedido. */
function talvezEnviarLembretes() {
  const agora = Date.now();
  if (agora - ultimaCarona < DE_CARONA_A_CADA_MS) return;
  ultimaCarona = agora;
  enviarLembretes().catch((e) => console.warn('[mensalidade] lembretes de carona:', e.message));
}

/** Só para os testes. */
const esquecerCarona = () => { ultimaCarona = 0; };

module.exports = { enviarLembretes, talvezEnviarLembretes, esquecerCarona };
