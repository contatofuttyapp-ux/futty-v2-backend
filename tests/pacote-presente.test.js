// Futty v2.0 — Rodada 31F: o Pacote do time está sempre à venda (presente para o time).
//
// Cada compra do futty_pacote SOMA +2 gerações para cada jogador do time (até 25 jogadores, a regra de sempre), em cima do que cada um já tem. O saldo de
// um jogador é `teams.brilhante_por_jogador` (= 2 × os pacotes do time) menos o que ele já gerou (`brilhantes_time.geracoes`), então um pacote novo soma
// por cima do que sobrou, e quem entra depois recebe tudo o que os pacotes já comprados dão. A mesma transação do RevenueCat nunca credita duas vezes
// (índice único (loja, transacao_id) + a leitura antes de gravar). O uniforme é o que o dono escolheu e a compra não o muda.
//
// Aqui o saldo é lido pelo MESMO portão que libera a geração (utils/direitoBrilhante.js#temDireito), sobre um Supabase falso em memória.
//
// Uso: npm test  (ou: node --test tests/pacote-presente.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar } = require('./_rotas');
const { criarCompras, GERACOES_POR_PACOTE, resumirReceita } = require('../utils/compras');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = '33333333-3333-3333-3333-333333333333';
const ANA = 'a0000000-0000-0000-0000-00000000000a'; // ainda não gerou nada
const BETO = 'b0000000-0000-0000-0000-00000000000b'; // já gerou as 2 do primeiro pacote
const NOVO = 'c0000000-0000-0000-0000-00000000000c'; // entra depois
const FORA = 'd0000000-0000-0000-0000-00000000000d'; // não é dono

const RELACOES = { team_members: { teams: { tabela: 'teams', local: 'team_id', remota: 'id' } } };
const membro = (user_id, role = 'member', time = TIME) => ({ team_id: time, user_id, role, joga: true });

function montar({ time = {}, extra = {} } = {}) {
  const avisos = [];
  const { carregados, cliente, tabelas } = carregar({
    users: [DONO, ANA, BETO, NOVO, FORA].map((id) => ({ id, brilhante_creditos: 0 })),
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: null, brilhante_origem: null, brilhante_limite: 25, brilhante_por_jogador: 2, ...time }],
    team_members: [membro(DONO, 'admin'), membro(ANA), membro(BETO)],
    pedidos_ativacao: [],
    brilhantes_time: [],
    compras: [],
    ...extra,
  }, ['utils/direitoBrilhante'], { relacoes: RELACOES });
  const compras = criarCompras({ supabase: cliente, notificar: (ids, payload) => avisos.push({ ids, payload }) });
  const { temDireito } = carregados['utils/direitoBrilhante'];
  const time_ = () => tabelas.teams.find((t) => t.id === TIME);
  const pacote = (n, extra2 = {}) => compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: `tx-pacote-${n}`, precoUsd: 12.99, moeda: 'USD', preco: 12.99, ...extra2 });
  const restantes = async (id) => (await temDireito(id)).restantes;
  return { compras, tabelas, avisos, time: time_, pacote, restantes, temDireito };
}

const jaGerou = (user_id, geracoes) => ({ team_id: TIME, user_id, geracoes, kit_id: 'dark-gold', avatar_url: 'x', custo_cents: 0 });

test('o saldo de um jogador depois de 1, 2 e 3 pacotes: cada um soma +2 em cima do que sobrou', async () => {
  // O time começa sem pacote nenhum comprado; Beto já gastou 2 gerações no time (do 1º pacote, que vai ser comprado agora).
  const { pacote, restantes, time } = montar({ time: { brilhante_kit: 'dark-gold' }, extra: { brilhantes_time: [jaGerou(BETO, 2)] } });
  const tabela = [];
  for (const n of [1, 2, 3]) {
    const r = await pacote(n);
    assert.equal(r.repetida, false);
    assert.equal(time().brilhante_por_jogador, GERACOES_POR_PACOTE * n, `o time tem ${GERACOES_POR_PACOTE * n} por jogador depois de ${n} pacote(s)`);
    tabela.push({ pacotes: n, porJogador: time().brilhante_por_jogador, ana: await restantes(ANA), beto: await restantes(BETO) });
  }
  // Ana (gerou 0): 2, 4, 6. Beto (já gerou as 2 do 1º pacote): 0, 2, 4 — o pacote novo soma por cima do que ele já usou.
  assert.deepEqual(tabela.map((l) => l.ana), [2, 4, 6]);
  assert.deepEqual(tabela.map((l) => l.beto), [0, 2, 4]);
  console.log('\n  pacotes | por jogador no time | Ana (gerou 0) | Beto (gerou 2)');
  for (const l of tabela) console.log(`     ${l.pacotes}    |         ${l.porJogador}           |       ${l.ana}       |       ${l.beto}`);
});

test('a MESMA transação nunca credita duas vezes (nem reenviada depois de outros pacotes)', async () => {
  const { pacote, restantes, time, tabelas } = montar({ time: { brilhante_kit: 'dark-gold' } });
  assert.equal((await pacote(1)).repetida, false);
  assert.equal((await pacote(2)).repetida, false);
  assert.equal(time().brilhante_por_jogador, 4);
  const de_novo = await pacote(1); // o RevenueCat reenvia o webhook da 1ª, e o "Restaurar compras" também
  assert.equal(de_novo.repetida, true);
  assert.equal((await pacote(2)).repetida, true);
  assert.equal(time().brilhante_por_jogador, 4, 'nada de +2 em dobro');
  assert.equal(await restantes(ANA), 4);
  assert.equal(tabelas.compras.filter((c) => c.produto === 'pacote').length, 2);
});

test('quem entra depois recebe as gerações de TODOS os pacotes já comprados', async () => {
  const { pacote, restantes, tabelas } = montar({ time: { brilhante_kit: 'dark-gold' } });
  await pacote(1);
  await pacote(2);
  assert.equal(await restantes(NOVO), 0, 'ainda não é do time');
  tabelas.team_members.push(membro(NOVO));
  assert.equal(await restantes(NOVO), 4, 'entrou depois de 2 pacotes: começa com as 4');
  await pacote(3);
  assert.equal(await restantes(NOVO), 6);
});

test('o limite de 25 jogadores continua o de hoje: o 26º, que ainda não gerou, não entra no pacote (o saldo dos que já têm linha sim)', async () => {
  const vinte5 = Array.from({ length: 25 }, (_, i) => jaGerou(`e0000000-0000-0000-0000-${String(i).padStart(12, '0')}`, 1));
  const { pacote, restantes, tabelas } = montar({ time: { brilhante_kit: 'dark-gold' }, extra: { brilhantes_time: vinte5 } });
  tabelas.team_members.push(...vinte5.map((l) => membro(l.user_id)));
  await pacote(1);
  await pacote(2);
  assert.equal(await restantes(ANA), 0, 'a vaga 26 não existe, por mais pacotes que se compre');
  assert.equal(await restantes(vinte5[0].user_id), 3, 'quem já tem linha: 4 do time − 1 que já gerou');
});

test('o uniforme é o que o dono escolheu: comprar de novo não o troca (e ele pode trocar como sempre)', async () => {
  const { pacote, time } = montar({ time: { brilhante_kit: 'dark-gold' } });
  await pacote(1);
  time().brilhante_kit = 'royal'; // o dono troca o uniforme do time
  await pacote(2);
  assert.equal(time().brilhante_kit, 'royal');
  assert.equal(time().brilhante_ativo, true);
});

test('time que o Gabinete ligou à mão (sem linha em compras) e comprou 1 pacote: 2 + 2 = 4 por jogador', async () => {
  const { pacote, time, restantes, tabelas } = montar({ time: { brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_origem: 'gabinete', brilhante_por_jogador: 2 } });
  assert.equal(await restantes(ANA), 2);
  await pacote(1);
  assert.equal(time().brilhante_por_jogador, 4);
  assert.equal(await restantes(ANA), 4);
  await pacote(2);
  assert.equal(time().brilhante_por_jogador, 6);
  // O pacote antigo, sem linha, ganhou a dele (uma só, mesmo com mais compras) e não entra na receita do Gabinete.
  const legado = tabelas.compras.filter((c) => c.payload?.legado);
  assert.equal(legado.length, 1);
  assert.equal(tabelas.compras.filter((c) => c.produto === 'pacote').length, 3);
  assert.equal(resumirReceita(tabelas.compras).concessoes_mes, 0);
  assert.equal(resumirReceita(tabelas.compras).compras_mes, 2);
});

test('a data da 1ª ativação fica; os membros ganham um aviso diferente quando é um pacote de presente', async () => {
  const { pacote, time, avisos } = montar({ time: { brilhante_kit: 'dark-gold' } });
  await pacote(1);
  const primeira = time().brilhante_ativado_em;
  assert.ok(primeira);
  assert.equal(avisos[0].payload.title, 'Sua figurinha foi liberada ✨');
  const r = await pacote(2);
  assert.equal(time().brilhante_ativado_em, primeira, 'a ativação é a do 1º pacote');
  assert.equal(r.presente, true);
  assert.equal(avisos[1].payload.title, 'Mais figurinhas pro seu time ✨');
  assert.match(avisos[1].payload.body, /\+2 gerações para cada jogador/);
  assert.ok(avisos[1].ids.includes(ANA) && avisos[1].ids.includes(BETO));
});

test('reembolso do 2º pacote tira as 2 dele e mantém o 1º; o do último desliga o pacote', async () => {
  const { pacote, compras, time, restantes } = montar({ time: { brilhante_kit: 'dark-gold' } });
  await pacote(1);
  await pacote(2);
  assert.equal(time().brilhante_por_jogador, 4);
  const r = await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-pacote-2' });
  assert.equal(r.pacoteDesligado, false);
  assert.equal(time().brilhante_por_jogador, 2);
  assert.equal(time().brilhante_ativo, true);
  assert.equal(await restantes(ANA), 2);
  assert.equal((await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-pacote-2' })).repetida, true, 'reembolso repetido não mexe');
  assert.equal(time().brilhante_por_jogador, 2);
  const ultimo = await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-pacote-1' });
  assert.equal(ultimo.pacoteDesligado, true);
  assert.equal(time().brilhante_ativo, false);
});

test('só o dono compra: quem não é dono leva NAO_E_DONO e nada muda', async () => {
  const { compras, time, tabelas } = montar({ time: { brilhante_kit: 'dark-gold' } });
  await assert.rejects(compras.aplicarCompra({ userId: ANA, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-x' }), { codigo: 'NAO_E_DONO' });
  assert.equal(time().brilhante_ativo, false);
  assert.equal(tabelas.compras.length, 0);
  void FORA;
});

test('sem a coluna brilhante_por_jogador (migração 059 por aplicar), a compra liga o pacote do mesmo jeito', async () => {
  const { carregados, cliente, tabelas } = carregar({
    users: [{ id: DONO, brilhante_creditos: 0 }],
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: 'dark-gold', brilhante_origem: null }],
    team_members: [membro(DONO, 'admin')],
    pedidos_ativacao: [], brilhantes_time: [], compras: [],
  }, ['utils/direitoBrilhante'], {
    relacoes: RELACOES,
    falhar: (tabela, op, e) => (tabela === 'teams' && op === 'update' && 'brilhante_por_jogador' in e.patch ? { message: 'column "brilhante_por_jogador" of relation "teams" does not exist' } : null),
  });
  void carregados;
  const compras = criarCompras({ supabase: cliente, notificar: () => {} });
  const r = await compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-1' });
  assert.equal(r.repetida, false);
  assert.equal(tabelas.teams[0].brilhante_ativo, true);
});
