// Futty v2.0 — Os times que o app manda (montar à mão, ajustar depois do sorteio): o que entra em `games.times_resultado`.
//
// Quem escreve o resultado do sorteio é o motor; mas nos dois caminhos à mão (POST /times-manuais e PATCH /times) os times chegam do
// corpo do pedido, e o corpo aceita qualquer JSON de até 2 MB. Aqui cada time e cada jogador são reconstruídos: os campos conhecidos com
// o tipo certo e um teto (nome, avatar), os outros só se forem número, boolean ou texto curto — nada de objeto dentro de objeto, nada
// de campo de 1 MB. O avatar só vale se for foto nossa (utils/validarUrl.js#urlDeAvatarValida); o resto vira "sem foto".
const { HttpError } = require('./http');
const { textoCurto, ehUuid } = require('./entrada');
const { urlDeAvatarValida } = require('./validarUrl');

const MAX_TIMES = 8;
const MAX_JOGADORES_POR_TIME = 30;
const MAX_RESERVAS = 40;
const MAX_NOME_DO_TIME = 40;
const MAX_NOME_DO_JOGADOR = 60;
const MAX_TEXTO_EXTRA = 60;

const jogadorInvalido = () => new HttpError(400, 'Um dos jogadores veio num formato que não dá para ler.');

/** Um jogador do corpo → o jogador que o motor guarda. `req` serve para conferir o endereço do avatar. */
function limparJogador(j, req) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw jogadorInvalido();
  const userId = j.user_id === undefined || j.user_id === null || j.user_id === '' ? null : j.user_id;
  if (userId !== null && !ehUuid(userId)) throw jogadorInvalido();
  const nome = textoCurto(j.nome, MAX_NOME_DO_JOGADOR, 'Nome do jogador');
  if (!userId && !nome) throw new HttpError(400, 'Todo jogador sem conta precisa de um nome.');
  const saida = {};
  // Os campos extras que o motor já guarda (rating, goleiro, posição na reserva…): só primitivos curtos.
  for (const [chave, valor] of Object.entries(j)) {
    if (['user_id', 'nome', 'avatar_url', 'convidado'].includes(chave) || chave === '__proto__') continue;
    if (typeof valor === 'boolean' || valor === null) saida[chave] = valor;
    else if (typeof valor === 'number' && Number.isFinite(valor)) saida[chave] = valor;
    else if (typeof valor === 'string' && valor.length <= MAX_TEXTO_EXTRA) saida[chave] = valor;
  }
  saida.user_id = userId;
  saida.nome = nome;
  saida.avatar_url = j.avatar_url && urlDeAvatarValida(j.avatar_url, req) ? String(j.avatar_url) : null;
  if (!userId && j.convidado) saida.convidado = true;
  return saida;
}

/** Os times do corpo → os times que o motor guarda (no máximo 8, de 1 a 30 jogadores cada). */
function limparTimes(times, req, nomePadrao) {
  if (!Array.isArray(times) || !times.length) throw new HttpError(400, 'Indique os times.');
  if (times.length > MAX_TIMES) throw new HttpError(400, `No máximo ${MAX_TIMES} times.`);
  return times.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t) || !Array.isArray(t.jogadores) || t.jogadores.length < 1) {
      throw new HttpError(400, 'Cada time deve ter pelo menos 1 jogador.');
    }
    if (t.jogadores.length > MAX_JOGADORES_POR_TIME) throw new HttpError(400, `No máximo ${MAX_JOGADORES_POR_TIME} jogadores por time.`);
    const saida = {};
    for (const [chave, valor] of Object.entries(t)) {
      if (['nome', 'jogadores'].includes(chave) || chave === '__proto__') continue;
      if (typeof valor === 'boolean' || valor === null) saida[chave] = valor;
      else if (typeof valor === 'number' && Number.isFinite(valor)) saida[chave] = valor;
    }
    saida.nome = textoCurto(t.nome, MAX_NOME_DO_TIME, 'Nome do time') || nomePadrao(i);
    saida.jogadores = t.jogadores.map((j) => limparJogador(j, req));
    return saida;
  });
}

/** As reservas do corpo (podem não existir). */
function limparReservas(reservas, req) {
  if (reservas === undefined || reservas === null) return [];
  if (!Array.isArray(reservas)) throw new HttpError(400, 'As reservas vieram num formato que não dá para ler.');
  if (reservas.length > MAX_RESERVAS) throw new HttpError(400, `No máximo ${MAX_RESERVAS} reservas.`);
  return reservas.map((j) => limparJogador(j, req));
}

module.exports = { limparTimes, limparReservas, limparJogador, MAX_NOME_DO_TIME, MAX_NOME_DO_JOGADOR };
