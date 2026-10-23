// Futty v2.0 — Os convidados sem app de um jogo: a lista que o admin escreve em "Alguém sem o app vai jogar?", com as marcas do sorteio.
//
// Cada convidado é { nome, goleiro, cabeca_chave } e mora em `games.convidados` (migração 087). Convidado nunca vira linha em `users`: vive
// pelo nome, como no sorteio. NULL na coluna = o jogo nunca gravou a lista (jogo de antes da 087, ou motor antes da migração): aí os
// convidados são os que estão no sorteio salvo, com as marcas que tinham lá. Assim o jogo que já foi sorteado mostra a lista certa sem
// ninguém mexer nele. Aqui só a parte pura (sem banco), para testar no Node.

// Os tetos do sorteio (SPEC-SORTEIO §14): 28 participantes no máximo; o nome com o mesmo teto que o sorteio sempre usou.
const MAX_CONVIDADOS = 28;
const MAX_NOME = 40;

const nomeNorm = (n) => String(n ?? '').trim().toLowerCase();

/** Um convidado do jeito que o motor guarda. Aceita o nome solto (o app antigo manda só o texto) ou o objeto. Null se não tem nome. */
function umConvidado(c) {
  const bruto = typeof c === 'string' ? { nome: c } : c && typeof c === 'object' ? c : null;
  if (!bruto || typeof bruto.nome !== 'string') return null;
  const nome = bruto.nome.trim().slice(0, MAX_NOME).trim();
  if (!nome) return null;
  return { nome, goleiro: bruto.goleiro === true, cabeca_chave: bruto.cabeca_chave === true };
}

/** A lista limpa: só quem tem nome, no teto do sorteio. Não junta nomes repetidos (quem valida isso é `nomeRepetido`). */
function limparConvidados(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.map(umConvidado).filter(Boolean).slice(0, MAX_CONVIDADOS);
}

/** O primeiro nome que aparece duas vezes (sem olhar maiúscula nem espaço), ou null. Dois "Beto" viram uma pessoa só no Associar e nos gols. */
function nomeRepetido(lista) {
  const vistos = new Set();
  for (const c of lista || []) {
    const n = nomeNorm(c?.nome);
    if (vistos.has(n)) return c.nome;
    vistos.add(n);
  }
  return null;
}

/** Os convidados que estão no sorteio salvo (times e reservas), com as marcas de lá. É a lista de quem nunca gravou `games.convidados`. */
function convidadosDoSorteio(tr) {
  const jogadores = [...(tr?.times || []).flatMap((t) => t?.jogadores || []), ...(tr?.reservas || [])];
  return limparConvidados(jogadores.filter((j) => j && !j.user_id));
}

/** Os convidados do jogo: a lista gravada, ou (se o jogo nunca gravou) a do sorteio salvo. */
function convidadosGuardados(game) {
  if (Array.isArray(game?.convidados)) return limparConvidados(game.convidados);
  return convidadosDoSorteio(game?.times_resultado);
}

/** A lista sem o convidado `nome` (o Associar: a vaga dele agora é de uma conta, e quem tem conta não conta duas vezes). */
function semConvidado(lista, nome) {
  const alvo = nomeNorm(nome);
  return limparConvidados(lista).filter((c) => nomeNorm(c.nome) !== alvo);
}

/** A lista com o convidado de volta (o Desfazer do Associar), no fim; se já está lá, fica como está. */
function comConvidado(lista, convidado) {
  const limpa = limparConvidados(lista);
  const novo = umConvidado(convidado);
  if (!novo || limpa.some((c) => nomeNorm(c.nome) === nomeNorm(novo.nome))) return limpa;
  return limparConvidados([...limpa, novo]);
}

// O erro do banco quando a coluna ainda não existe (a 087 não rodou): o motor segue sem gravar a lista em vez de quebrar o sorteio.
const semAColuna = (error) => !!error && /convidados/i.test(String(error.message || '')) && /column|coluna|schema/i.test(String(error.message || ''));

module.exports = {
  MAX_CONVIDADOS, MAX_NOME, umConvidado, limparConvidados, nomeRepetido, convidadosDoSorteio, convidadosGuardados, semConvidado, comConvidado, semAColuna,
};
