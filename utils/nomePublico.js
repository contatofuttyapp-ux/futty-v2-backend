// Futty v2.0 — O nome de uma pessoa onde quem olha NÃO está logado: a página pública do sorteio, a do campeonato, o convite, os cartões 9:16
// que vão para o WhatsApp.
//
// A regra do dono (12-out): ali aparece o APELIDO — o nome de jogador do app (`users.nome_jogador`) — e nunca o nome completo. Quem ainda
// não escolheu apelido aparece só pelo PRIMEIRO nome (o nome completo é dado pessoal que a pessoa deu ao app, não a quem recebe um link).
// Dentro do time (logado) nada muda: lá a lista continua "apelido → nome → Jogador" (frontend/src/utils/nomeExibicao.js).
//
// Função pura (sem banco, sem rede) + o carregador dos apelidos por id, que as rotas públicas usam.

/** O apelido da pessoa; sem apelido, o primeiro nome; sem nada, "Jogador". Nunca o nome completo, nunca o e-mail. */
function nomePublico(usuario) {
  const apelido = String(usuario?.nome_jogador ?? '').trim();
  if (apelido) return apelido;
  const primeiro = String(usuario?.nome ?? '').trim().split(/\s+/)[0];
  return primeiro || 'Jogador';
}

/** O nome que o sorteio e o campeonato guardam para um jogador que TEM conta, num `Map` id → nome público (para a leitura). */
function mapaDeNomesPublicos(usuarios) {
  return new Map((usuarios || []).filter((u) => u && u.id).map((u) => [u.id, nomePublico(u)]));
}

/**
 * Troca, na LEITURA, o nome de cada jogador que tem conta pelo nome público de hoje. O snapshot do sorteio é uma cópia do nome de quando
 * foi feito (às vezes o nome completo, de quem não tinha apelido, ou um apelido que a pessoa trocou depois): na tela pública sai o de agora.
 * Quem não está no mapa (convidado sem app, conta apagada) mantém o nome do snapshot. Não altera o `tr` recebido.
 * @param {object} tr times_resultado ({ times:[{jogadores:[]}], reservas:[], registro? })
 * @param {Map<string,string>} nomePorUsuario user_id → nome público
 */
function comNomesPublicos(tr, nomePorUsuario) {
  if (!tr || typeof tr !== 'object' || !nomePorUsuario || !nomePorUsuario.size) return tr;
  const trocar = (j) => (j && j.user_id && nomePorUsuario.has(j.user_id) ? { ...j, nome: nomePorUsuario.get(j.user_id) } : j);
  const refazer = (r) => ({
    ...r,
    times: (r.times || []).map((t) => ({ ...t, jogadores: (t.jogadores || []).map(trocar) })),
    ...(Array.isArray(r.reservas) ? { reservas: r.reservas.map(trocar) } : {}),
  });
  const novo = refazer(tr);
  // O que a roleta deu antes de um ajuste (utils/registroDoSorteio.js) é a mesma gente: o mesmo nome.
  if (tr.registro?.original) novo.registro = { ...tr.registro, original: refazer(tr.registro.original) };
  return novo;
}

/** Lê `users` e devolve o mapa id → nome público. `supabase` entra por parâmetro para o teste. Falha de leitura = mapa vazio (a rota decide). */
async function carregarNomesPublicos(supabase, ids) {
  const lista = [...new Set((ids || []).filter(Boolean))];
  if (!lista.length) return new Map();
  const { data, error } = await supabase.from('users').select('id, nome, nome_jogador').in('id', lista);
  if (error) return new Map();
  return mapaDeNomesPublicos(data);
}

module.exports = { nomePublico, mapaDeNomesPublicos, comNomesPublicos, carregarNomesPublicos };
