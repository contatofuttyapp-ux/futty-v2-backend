// Futty v2.0 — O avatar de HOJE nos jogadores de um sorteio (Rodada 27, 25-set).
//
// O sorteio guarda uma CÓPIA do avatar_url de cada jogador no instante em que foi feito:
// `times_resultado` é um snapshot, e precisa ser (o replay da cerimônia sai igual pela seed).
// Só que a cópia envelhece: quem trocava a foto, ou reajustava o enquadramento, depois do
// sorteio continuava aparecendo com a foto ANTIGA no cartão do sorteio e na lista de sorteados.
//
// Na LEITURA, o avatar de quem ainda tem conta passa a ser o de hoje. O resto do snapshot
// (times, ordem, seed, nomes, notas) fica como está. Quem não está no mapa (convidado, conta
// apagada) mantém a cópia; quem hoje não tem avatar também (não se apaga rosto do histórico).

/**
 * @param {object} tr times_resultado ({ times:[{jogadores:[]}], reservas:[] }) — não é alterado
 * @param {Map<string, string|null>} avatarPorUsuario user_id → avatar_url de hoje
 * @returns {object} uma cópia de `tr` com os avatares atuais
 */
function comAvataresAtuais(tr, avatarPorUsuario) {
  if (!tr || typeof tr !== 'object' || !avatarPorUsuario || !avatarPorUsuario.size) return tr;
  const atualizar = (j) => {
    if (!j || !j.user_id || !avatarPorUsuario.has(j.user_id)) return j;
    const hoje = avatarPorUsuario.get(j.user_id);
    return hoje ? { ...j, avatar_url: hoje } : j;
  };
  return {
    ...tr,
    times: (tr.times || []).map((t) => ({ ...t, jogadores: (t.jogadores || []).map(atualizar) })),
    ...(Array.isArray(tr.reservas) ? { reservas: tr.reservas.map(atualizar) } : {}),
  };
}

module.exports = { comAvataresAtuais };
