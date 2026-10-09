// Futty v2.0 — O registro de quem fez os times de um jogo, dentro de `times_resultado.registro`.
//
// "Sorteio justo, na frente de todo mundo" só é verdade se a tela disser quando os times NÃO saíram
// (só) da roleta. Por isso o motor anota, no momento de cada ação, quem a fez — e só o motor escreve
// aqui: o que o app manda no corpo de um ajuste é ignorado (senão bastava apagar o registro ao salvar).
//
//   origem   'sorteio' (saiu da roleta) | 'manual' (montado à mão desde o início)
//   por      { id, nome } de quem sorteou / montou — o nome de guerra NAQUELE momento (trocar o nome
//            depois não reescreve o passado); null em jogo antigo, de antes do registro
//   em       ISO da ação
//   original { times, reservas } — o que a roleta deu, guardado no 1º ajuste e nunca mais mexido
//   ajustes  [{ por, em }] — cada vez que alguém mexeu nos times depois de prontos
//
// Fica em JSON dentro do próprio resultado (sem coluna nova): vai junto com os times para todo lado.
// Nada disto muda a matemática do sorteio (utils/sorteio.js).

/** A chave de um jogador para comparar listas: o id de quem tem conta, o nome de quem é convidado sem app. */
function chaveDoJogador(j) {
  if (!j) return null;
  return j.user_id ? `u:${j.user_id}` : `c:${String(j.nome || '').trim().toLowerCase()}`;
}

/** Onde cada jogador está: chave → índice do time, ou 'reserva'. */
function posicoes(times, reservas) {
  const onde = new Map();
  (times || []).forEach((t, i) => (t?.jogadores || []).forEach((j) => onde.set(chaveDoJogador(j), i)));
  (reservas || []).forEach((j) => onde.set(chaveDoJogador(j), 'reserva'));
  return onde;
}

/** Os mesmos jogadores nos mesmos lugares (a ordem dentro do time não conta)? */
function mesmaDistribuicao(a, b) {
  const pa = posicoes(a?.times, a?.reservas);
  const pb = posicoes(b?.times, b?.reservas);
  if (pa.size !== pb.size) return false;
  for (const [k, v] of pa) if (pb.get(k) !== v) return false;
  return true;
}

/** O registro de um resultado antigo (sem `registro`): com seed foi sorteio; sem, montado à mão. Sem nome. */
function registroDe(tr) {
  if (tr?.registro && typeof tr.registro === 'object') return tr.registro;
  if (!tr) return null;
  return { origem: tr.seed != null ? 'sorteio' : 'manual', por: null, em: null, ajustes: [] };
}

/**
 * Quantos sorteios este jogo já teve. "Sortear de novo" apaga os times de antes; sem esta conta, o 2º sorteio
 * (feito porque o 1º não agradou) passaria pelo 1º. A conta atravessa montagens à mão e ajustes. Resultado antigo,
 * sem a conta: com seed foi 1 sorteio, sem seed nenhum.
 */
function quantosSorteios(tr) {
  if (Number.isInteger(tr?.registro?.sorteios)) return tr.registro.sorteios;
  return tr?.seed != null ? 1 : 0;
}

/** Registro de um sorteio novo, feito por `quem` agora; `anterior` é o resultado que ele substitui. */
function registroDeSorteio(quem, agora, anterior = null) {
  const numero = quantosSorteios(anterior) + 1;
  return { origem: 'sorteio', por: quem || null, em: agora, ajustes: [], sorteio_numero: numero, sorteios: numero };
}

/** Registro de times montados à mão desde o início (sem roleta), por `quem` agora. A conta dos sorteios fica. */
function registroDeMontagem(quem, agora, anterior = null) {
  return { origem: 'manual', por: quem || null, em: agora, ajustes: [], sorteios: quantosSorteios(anterior) };
}

/**
 * O resultado depois de um ajuste à mão. Parte do que está GRAVADO (`anterior`) — do corpo só entram os
 * times e as reservas. Na 1ª vez que um sorteio é ajustado, os times de antes viram o `original`; nos ajustes
 * seguintes o original fica o mesmo e o ajuste só entra na lista. Se ninguém mudou de lugar, não há ajuste a
 * registrar (salvar sem mexer não carimba "ajustado").
 */
function resultadoAjustado(anterior, { times, reservas }, quem, agora) {
  const reg = registroDe(anterior) || registroDeMontagem(null, null);
  const base = { ...(anterior || {}) };
  delete base.registro;
  const novo = { ...base, times, reservas, num_times: times.length };
  const mudou = !mesmaDistribuicao(anterior, novo);
  if (!mudou) return { ...novo, registro: reg };
  const ajustes = [...(Array.isArray(reg.ajustes) ? reg.ajustes : []), { por: quem || null, em: agora }];
  const registro = { ...reg, ajustes };
  if (reg.origem === 'sorteio' && !reg.original) {
    registro.original = { times: anterior?.times || [], reservas: anterior?.reservas || [] };
  }
  return { ...novo, registro };
}

/** Na vista pública ninguém precisa do id de quem sorteou/ajustou — só o nome que o selo mostra. */
function registroPublico(registro) {
  if (!registro || typeof registro !== 'object') return registro;
  const semId = (p) => (p ? { nome: p.nome || null } : null);
  return {
    ...registro,
    por: semId(registro.por),
    ajustes: (registro.ajustes || []).map((a) => ({ ...a, por: semId(a.por) })),
  };
}

module.exports = {
  chaveDoJogador, mesmaDistribuicao, quantosSorteios, registroDe, registroDeSorteio, registroDeMontagem, resultadoAjustado, registroPublico,
};
