// Futty v2.0 — Ajudantes comuns das rotas do jogo (routes/games.js e os sub-roteadores dele).

const { supabase } = require('./db');
const { nomePublico } = require('./nomePublico');

/** Quem fez a ação, com o nome de guerra DE AGORA — o selo grava este nome e não muda se a pessoa o trocar depois. */
async function quemFez(userId) {
  const { data } = await supabase.from('users').select('nome, nome_jogador').eq('id', userId).maybeSingle();
  // O registro do sorteio sai na página pública: o apelido (ou só o primeiro nome), nunca o nome completo.
  return { id: userId, nome: data ? nomePublico(data) : null };
}

const round1 = (n) => Math.round(n * 10) / 10;

module.exports = { quemFez, round1 };
