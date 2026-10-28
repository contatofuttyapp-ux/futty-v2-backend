// Futty v2.0 — a ida única (utils/idaUnica.js): a função do banco ausente, falhando ou fora do formato → null (a rota segue pelo caminho
// antigo), com UMA linha de aviso e a falta lembrada por 1 minuto; a função de volta → o JSON dela.
//
// Uso: node --test tests/ida-unica.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarIdaUnica, LEMBRAR_FALTA_MS, VERSAO } = require('../utils/idaUnica');

function cenario(resposta) {
  let agora = 1_000_000;
  const chamadas = [];
  const log = { avisos: [], erros: [], warn: (...a) => log.avisos.push(a.join(' ')), error: (...a) => log.erros.push(a.join(' ')) };
  const cliente = { rpc: async (nome, args) => { chamadas.push([nome, args]); return typeof resposta === 'function' ? resposta() : resposta; } };
  const ida = criarIdaUnica('inicio_da_pessoa', { cliente, agora: () => agora, log });
  return { ida, chamadas, log, andar: (ms) => { agora += ms; }, trocar: (r) => { resposta = r; } };
}

const AUSENTE = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.inicio_da_pessoa(p_agora, p_uid) in the schema cache' } };

test('função ausente: null, UMA linha de aviso e a falta lembrada por 1 minuto (o pedido seguinte nem tenta)', async () => {
  const c = cenario(AUSENTE);
  assert.equal(await c.ida.chamar({ p_uid: 'u1' }), null);
  assert.equal(await c.ida.chamar({ p_uid: 'u1' }), null);
  assert.equal(c.chamadas.length, 1);
  assert.equal(c.log.avisos.length, 1);
  assert.match(c.log.avisos[0], /inicio_da_pessoa não existe no banco \(migração 090\)/);
  c.andar(LEMBRAR_FALTA_MS + 1);
  assert.equal(await c.ida.chamar({ p_uid: 'u1' }), null);
  assert.equal(c.chamadas.length, 2, 'passado o minuto, tenta de novo');
  assert.equal(c.log.avisos.length, 1, 'o aviso não se repete');
});

test('a migração roda: a função aparece e o JSON dela vem inteiro', async () => {
  const c = cenario(AUSENTE);
  await c.ida.chamar({ p_uid: 'u1' });
  c.trocar({ data: { versao: VERSAO, vinculos: [] }, error: null });
  c.andar(LEMBRAR_FALTA_MS + 1);
  assert.deepEqual(await c.ida.chamar({ p_uid: 'u1', p_agora: 'x' }), { versao: VERSAO, vinculos: [] });
  assert.deepEqual(c.chamadas.at(-1), ['inicio_da_pessoa', { p_uid: 'u1', p_agora: 'x' }]);
});

test('outro erro (tempo esgotado) ou formato de outra versão: null e uma linha de erro, sem lembrar falta (o próximo tenta)', async () => {
  const c = cenario({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
  assert.equal(await c.ida.chamar({}), null);
  assert.equal(await c.ida.chamar({}), null);
  assert.equal(c.chamadas.length, 2);
  assert.equal(c.log.erros.length, 2);
  assert.equal(c.log.avisos.length, 0);
  c.trocar({ data: { versao: VERSAO + 1 }, error: null });
  assert.equal(await c.ida.chamar({}), null);
  assert.match(c.log.erros.at(-1), /fora do formato/);
});

test('um cliente sem rpc (banco falso antigo) conta como função ausente', async () => {
  const log = { avisos: [], warn: (m) => log.avisos.push(m), error: () => {} };
  const ida = criarIdaUnica('inicio_da_pessoa', { cliente: {}, log });
  assert.equal(await ida.chamar({}), null);
  assert.equal(log.avisos.length, 1);
});
