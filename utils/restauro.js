// Futty v2.0 — A lógica pura do restauro de backup (Manutenção 26-set, item B.5).
// Separada de scripts/restaurar-banco.js (que só lê arquivo e fala com o Supabase)
// para poder ser testada sem rede — mesmo espírito de utils/orfaos.js.
//
// ORDEM_TABELAS respeita as FKs das migrações (backend/db/migrations/*.sql): quem é
// referenciado vem antes de quem referencia (users antes de teams, teams antes de
// team_members, games antes de votes/rsvp/gols_jogadores, etc.) — um upsert de uma
// tabela filha antes da mãe falha por violação de FK.
const ORDEM_TABELAS = [
  'users', 'app_config', 'gasto_ia_diario', 'telemetria_velocidade', 'geracao_ia_log',
  'teams', 'team_members', 'games', 'votes',
  'comentarios', 'comentario_anexos', 'feed_posts', 'feed_post_media',
  'reacoes', 'denuncias', 'champion_photos', 'team_join_requests',
  'convites', 'convite_usos', 'game_players', 'rsvp_espera', 'rsvp_respostas',
  'push_subscriptions', 'campeonatos', 'campeonato_jornadas', 'gols_jogadores',
  'user_blocks', 'share_declarations', 'user_avatar_slots', 'user_avatar_historico',
  'pedidos_ativacao', 'brilhantes_time',
];

const TAMANHO_LOTE = 500;

/** Divide `linhas` em lotes de `tamanho` (padrão 500). */
function emLotes(linhas, tamanho = TAMANHO_LOTE) {
  const lotes = [];
  for (let i = 0; i < linhas.length; i += tamanho) lotes.push(linhas.slice(i, i + tamanho));
  return lotes;
}

/** Filtra `tabelas` pedidas para a ordem de dependência de ORDEM_TABELAS —
 * nomes fora de ORDEM_TABELAS são ignorados (tabela desconhecida). */
function ordemRestauro(tabelas) {
  const pedidas = new Set(tabelas);
  return ORDEM_TABELAS.filter((t) => pedidas.has(t));
}

/** Restaura uma tabela, em lotes de TAMANHO_LOTE, por upsert. Sem `gravar`, só
 * simula (não chama o cliente) — devolve a contagem de linhas e lotes mesmo assim,
 * para o modo simulação poder imprimir o que faria. Um erro num lote interrompe
 * os lotes seguintes DESTA tabela (propaga para quem chamou parar tudo). */
async function restaurarTabela(cliente, nome, linhas, { gravar } = {}) {
  const lotes = emLotes(linhas);
  if (!gravar) {
    return { tabela: nome, linhas: linhas.length, lotes: lotes.length, gravado: false };
  }
  for (const lote of lotes) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await cliente.from(nome).upsert(lote);
    if (error) throw new Error(`${nome}: ${error.message}`);
  }
  return { tabela: nome, linhas: linhas.length, lotes: lotes.length, gravado: true };
}

/** Restaura várias tabelas na ordem de dependência. `dados` é { nomeTabela: linhas[] }.
 * Um erro em qualquer tabela para tudo — as tabelas seguintes na ordem não rodam
 * (o for simplesmente não continua; quem chama vê o throw). */
async function executarRestauro(cliente, dados, { gravar } = {}) {
  const ordem = ordemRestauro(Object.keys(dados));
  const resultados = [];
  for (const nome of ordem) {
    // eslint-disable-next-line no-await-in-loop
    resultados.push(await restaurarTabela(cliente, nome, dados[nome], { gravar }));
  }
  return resultados;
}

module.exports = { ORDEM_TABELAS, TAMANHO_LOTE, emLotes, ordemRestauro, restaurarTabela, executarRestauro };
