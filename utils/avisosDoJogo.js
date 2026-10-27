// Futty v2.0 — O CANO dos avisos de jogo: tudo o que avisa gente sobre um jogo passa por aqui.
//
//   · 'criado'  — o jogo foi marcado: chama quem foi chamado ("Você vai?");
//   · 'chamado' — o admin chamou mais alguém, ou alguém entrou no time e o jogo chama o elenco inteiro;
//   · 'mudou'   — mudou a data, a hora ou o local.
// Cada aviso fica REGISTRADO em `jogo_avisos` (quem, quando, o quê) e sai pelo Web Push que já existe (routes/push.js, que respeita
// quem desligou "Jogos" em Perfil → Notificações). O push nativo (iOS/Android) entra neste mesmo lugar: é só mais um envio depois do
// registro — nenhuma rota precisa mudar. Quem fez a ação nunca recebe o próprio aviso. Nunca lança: avisar não pode derrubar o pedido.
const { supabase } = require('./db');
const { fusoDoTime, dataCurtaNoFuso } = require('./fuso');
// O módulo (não a função): quem troca o envio nos testes troca a propriedade, e o carregador de rotas dos testes troca o módulo inteiro.
const push = require('../routes/push');

const faltaATabela = (erro) => !!erro && /jogo_avisos/i.test(erro.message || '') && /does not exist|schema cache/i.test(erro.message || '');

/** O texto do aviso. `team` precisa de nome, slug e fuso; `game` de id, data e local. */
function mensagem(tipo, { game, team }) {
  const quando = dataCurtaNoFuso(game.data, fusoDoTime(team));
  const onde = game.local ? ` · ${game.local}` : '';
  const url = `/time/${team.slug}/jogo/${game.id}`;
  if (tipo === 'mudou') return { title: `📅 O jogo do ${team.nome} mudou`, body: `Agora: ${quando}${onde}.`, url };
  if (tipo === 'chamado') return { title: `⚽ Você foi chamado para o jogo do ${team.nome}`, body: `${quando}${onde}. Você vai? Responda no app.`, url };
  return { title: `⚽ Jogo marcado: ${team.nome}`, body: `${quando}${onde}. Você vai? Responda no app.`, url };
}

/**
 * Registra o aviso e manda o push. `ids` = destinatários (o autor sai sozinho). `payload` troca o texto padrão (ex.: os jogos
 * recorrentes, que avisam uma vez só por vários jogos). Devolve { registrado, destinatarios }.
 * `enviar` é o envio do Web Push (por padrão o de routes/push.js; os testes trocam).
 */
async function avisarJogo(tipo, { game, team, ids, autorId = null, detalhe = null, payload = null }, { enviar = (...a) => push.enviarNotificacao(...a) } = {}) {
  const destinatarios = [...new Set((ids || []).filter((id) => id && id !== autorId))];
  let registro = null;
  try {
    const { data, error } = await supabase
      .from('jogo_avisos')
      .insert({ game_id: game.id, team_id: team.id, tipo, destinatarios, detalhe })
      .select('id')
      .single();
    if (error) {
      if (!faltaATabela(error)) console.warn(`[avisos] ${tipo} do jogo ${game.id} não registrado:`, error.message);
    } else {
      registro = data;
    }
  } catch (e) {
    console.warn(`[avisos] ${tipo} do jogo ${game.id} não registrado:`, e.message);
  }
  console.log(`[avisos] ${tipo} · jogo ${game.id} · ${destinatarios.length} pessoa(s)`);
  if (!destinatarios.length) return { registrado: !!registro, destinatarios };
  try {
    await enviar(destinatarios, payload || mensagem(tipo, { game, team }), { categoria: 'jogos' });
    if (registro) await supabase.from('jogo_avisos').update({ web_enviado_em: new Date().toISOString() }).eq('id', registro.id);
  } catch (e) {
    console.warn(`[avisos] push de ${tipo} do jogo ${game.id}:`, e.message);
  }
  return { registrado: !!registro, destinatarios };
}

/**
 * Alguém acabou de entrar no time: os jogos que chamam o ELENCO INTEIRO (games.chamados NULL) e ainda aceitam resposta passam a chamar
 * essa pessoa — ela já vê o "Você vai?" (a regra é de leitura) e recebe o aviso agora, um por jogo. Jogo com lista escolhida não muda
 * (é o admin quem chama mais gente nele). Nunca lança.
 */
async function chamarQuemEntrou(teamId, userId, opcoes = {}) {
  try {
    // eslint-disable-next-line global-require
    const { lerComChamada } = require('./colunasDaChamada');
    // eslint-disable-next-line global-require
    const { listaAberta, foiChamado } = require('./chamadaDoJogo');
    // eslint-disable-next-line global-require
    const { lerComFuso } = require('./fuso');
    // eslint-disable-next-line global-require
    const { soOrganiza } = require('./soOrganiza');
    if (await soOrganiza(teamId, userId)) return 0;
    const [{ data: team }, { data: jogos }] = await Promise.all([
      lerComFuso((novas) => supabase.from('teams').select(novas ? `id, slug, nome, ${novas}` : 'id, slug, nome').eq('id', teamId).maybeSingle()),
      lerComChamada((extra) => supabase.from('games').select(`id, data, local, status, cancelado, sorteio_realizado${extra}`)
        .eq('team_id', teamId).gte('data', new Date().toISOString()).order('data', { ascending: true })),
    ]);
    if (!team) return 0;
    let avisados = 0;
    for (const game of jogos || []) {
      if (!listaAberta(game) || Array.isArray(game.chamados) || !foiChamado(game, userId)) continue;
      // eslint-disable-next-line no-await-in-loop
      await avisarJogo('chamado', { game, team, ids: [userId], detalhe: { entrou_no_time: true } }, opcoes);
      avisados += 1;
    }
    return avisados;
  } catch (e) {
    console.warn('[avisos] chamar quem entrou no time:', e.message);
    return 0;
  }
}

module.exports = { avisarJogo, chamarQuemEntrou, mensagem };
