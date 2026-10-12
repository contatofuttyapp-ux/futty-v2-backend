// Futty v2.0 — "Associar jogador": o convidado sem app de um jogo vira a conta de um membro do time.
//
// O convidado nunca teve linha em `users`: ele vive pelo NOME dentro do sorteio (`times_resultado`), nos gols (`gols_jogadores.convidado_nome`)
// e no plantel dos campeonatos que nasceram daquele sorteio. Quando a pessoa baixa o app e entra no time, o admin liga os dois: tudo o que
// tinha o nome do convidado passa a ter o user_id do membro, na mesma posição. Aqui vive a parte PURA (sem banco), para testar no Node; a
// ordem das gravações está em routes/games.js.
//
// A troca é a mesma nos dois sentidos (associar / desfazer): só muda quem entra no lugar de quem.
// O "Desfazer" vale por um dia: o admin errou o toque, não reescreve a história do time.
const JANELA_DESFAZER_MS = 24 * 3600 * 1000;
const MAX_ASSOCIACOES_NO_REGISTRO = 50;

const nomeNorm = (n) => String(n ?? '').trim().toLowerCase();
const semConta = (j) => !!j && !j.user_id;

/** Todos os jogadores do resultado do sorteio (times e reservas), na ordem em que aparecem. */
function todosOsJogadores(tr) {
  return [...(tr?.times || []).flatMap((t) => t?.jogadores || []), ...(tr?.reservas || [])].filter(Boolean);
}

/** Onde o convidado de nome `nome` está: { time: índice | null, reserva: boolean, jogador } — ou null se não está no jogo. */
function acharConvidado(tr, nome) {
  const alvo = nomeNorm(nome);
  if (!alvo) return null;
  const times = tr?.times || [];
  for (let i = 0; i < times.length; i += 1) {
    const j = (times[i]?.jogadores || []).find((x) => semConta(x) && nomeNorm(x.nome) === alvo);
    if (j) return { time: i, reserva: false, jogador: j };
  }
  const r = (tr?.reservas || []).find((x) => semConta(x) && nomeNorm(x.nome) === alvo);
  return r ? { time: null, reserva: true, jogador: r } : null;
}

/** Os convidados sem app do jogo, para a tela listar: [{ nome, avatar_url, time (índice ou null), reserva }]. */
function convidadosDoJogo(tr) {
  const saida = [];
  (tr?.times || []).forEach((t, i) => (t?.jogadores || []).forEach((j) => {
    if (semConta(j)) saida.push({ nome: j.nome, avatar_url: j.avatar_url || null, time: i, time_nome: t.nome || null, reserva: false });
  }));
  (tr?.reservas || []).forEach((j) => { if (semConta(j)) saida.push({ nome: j.nome, avatar_url: j.avatar_url || null, time: null, time_nome: null, reserva: true }); });
  return saida;
}

/** O membro já ocupa uma vaga neste resultado (time ou reserva)? */
function membroNoResultado(tr, userId) {
  return todosOsJogadores(tr).some((j) => j.user_id === userId);
}

// Refaz uma lista de jogadores trocando UM (o que `casa` aceita) por `subst(jogador)`, na mesma posição. Devolve { lista, trocou }.
function trocarNaLista(lista, casa, subst) {
  let trocou = false;
  const nova = (lista || []).map((j) => {
    if (!trocou && j && casa(j)) { trocou = true; return subst(j); }
    return j;
  });
  return { lista: nova, trocou };
}

// A troca dentro de { times, reservas }: o primeiro jogador que `casa` aceita. Devolve { corpo, trocou }.
function trocarNoCorpo(corpo, casa, subst) {
  let feito = false;
  const times = (corpo?.times || []).map((t) => {
    if (feito) return t;
    const r = trocarNaLista(t?.jogadores, casa, subst);
    feito = r.trocou;
    return r.trocou ? { ...t, jogadores: r.lista } : t;
  });
  let reservas = corpo?.reservas;
  if (!feito && Array.isArray(reservas)) {
    const r = trocarNaLista(reservas, casa, subst);
    feito = r.trocou;
    reservas = r.lista;
  }
  return { corpo: { ...corpo, times, ...(Array.isArray(corpo?.reservas) ? { reservas } : {}) }, trocou: feito };
}

/**
 * `times_resultado` com o jogador que `casa` aceita trocado por `subst(jogador)`; o que a roleta deu antes de um ajuste
 * (`registro.original`) leva a mesma troca, para o registro continuar falando das mesmas pessoas. Não altera o recebido.
 * @returns {{ tr: object, trocou: boolean }}
 */
function trocarNoResultado(tr, casa, subst) {
  const { corpo, trocou } = trocarNoCorpo(tr, casa, subst);
  if (!trocou) return { tr, trocou: false };
  const novo = corpo;
  if (tr.registro?.original) novo.registro = { ...tr.registro, original: trocarNoCorpo(tr.registro.original, casa, subst).corpo };
  return { tr: novo, trocou: true };
}

/** Quem entra no lugar do convidado: o mesmo lugar e as mesmas anotações, agora com a conta do membro (e sem a marca de convidado). */
function jogadorComConta(convidado, membro) {
  const { convidado: _marca, ...resto } = convidado;
  return { ...resto, user_id: membro.user_id, nome: membro.nome, avatar_url: membro.avatar_url || null };
}

const ehEsteConvidado = (nome) => (j) => semConta(j) && nomeNorm(j.nome) === nomeNorm(nome);
const ehEsteMembro = (userId) => (j) => j.user_id === userId;

/**
 * No plantel de um campeonato (`camp.times[].jogadores`): `casa` → `subst`. É o plantel que dá o selo de campeão/vice/3º e o card
 * "Você é campeão!". Devolve { camp, trocou }; não altera o recebido.
 */
function trocarNoPlantel(camp, casa, subst) {
  let trocou = false;
  const times = (camp?.times || []).map((t) => {
    const r = trocarNaLista(t?.jogadores, casa, subst);
    if (!r.trocou) return t;
    trocou = true;
    return { ...t, jogadores: r.lista };
  });
  return { camp: trocou ? { ...camp, times } : camp, trocou };
}

/** Uma associação ainda pode ser desfeita? (não foi desfeita e está dentro das 24 h) */
function podeDesfazer(assoc, agora = Date.now()) {
  if (!assoc || assoc.desfeita_em) return false;
  const quando = new Date(assoc.em).getTime();
  return Number.isFinite(quando) && agora - quando <= JANELA_DESFAZER_MS;
}

/** A associação mais recente (não desfeita) deste membro neste resultado, ou null. */
function associacaoAtiva(tr, userId) {
  const lista = Array.isArray(tr?.registro?.associacoes) ? tr.registro.associacoes : [];
  for (let i = lista.length - 1; i >= 0; i -= 1) if (lista[i]?.user_id === userId && !lista[i].desfeita_em) return lista[i];
  return null;
}

/** O que a tela precisa de cada associação ainda desfazível (sem expor mais do que o admin precisa). */
function associacoesDesfaziveis(tr, agora = Date.now()) {
  const lista = Array.isArray(tr?.registro?.associacoes) ? tr.registro.associacoes : [];
  return lista.filter((a) => podeDesfazer(a, agora)).map((a) => ({
    user_id: a.user_id, nome: a.nome || null, convidado_nome: a.convidado?.nome || null, em: a.em,
    desfazer_ate: new Date(new Date(a.em).getTime() + JANELA_DESFAZER_MS).toISOString(),
  }));
}

/** O registro com mais uma associação (ou com a marca de desfeita). Parte do que está gravado; só o motor escreve aqui. */
function registroComAssociacoes(registro, associacoes) {
  return { ...(registro || {}), associacoes: associacoes.slice(-MAX_ASSOCIACOES_NO_REGISTRO) };
}

module.exports = {
  JANELA_DESFAZER_MS, nomeNorm, semConta, todosOsJogadores, acharConvidado, convidadosDoJogo, membroNoResultado, trocarNoResultado, jogadorComConta,
  ehEsteConvidado, ehEsteMembro, trocarNoPlantel, podeDesfazer, associacaoAtiva, associacoesDesfaziveis, registroComAssociacoes,
};
