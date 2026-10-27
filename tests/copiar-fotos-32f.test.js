// Futty v2.0 — scripts/copiar-fotos-32f.js (Rodada 32F) sobre um Storage de mentira: o plano troca só o id do começo do nome,
// a cópia não repete o que já existe, nada é apagado, a tmp/ fica de fora, e contas que não batem com o mapa param tudo.
//
// Uso: npm test  (ou: node --test tests/copiar-fotos-32f.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CONTAS, conferirContas, planejar, copiar } = require('../scripts/copiar-fotos-32f');

const A = CONTAS.antiga.id;
const N = CONTAS.nova.id;

function clienteFalso({ arquivos, usuarios = [{ id: A, email: CONTAS.antiga.email }, { id: N, email: CONTAS.nova.email }] }) {
  const bucket = new Set(arquivos);
  const operacoes = [];
  return {
    bucket,
    operacoes,
    from: () => ({
      select: () => ({
        eq: (_col, email) => ({ maybeSingle: async () => ({ data: usuarios.find((u) => u.email === email) || null, error: null }) }),
      }),
    }),
    storage: {
      from: () => ({
        async list(pasta, { search }) {
          const nomes = [...bucket].filter((c) => c.startsWith(`${pasta}/`)).map((c) => c.slice(pasta.length + 1)).filter((n) => n.includes(search));
          return { data: nomes.map((name) => ({ name })), error: null };
        },
        async copy(de, para) {
          operacoes.push(['copy', de, para]);
          if (!bucket.has(de)) return { error: { message: 'Object not found' } };
          bucket.add(para);
          return { error: null };
        },
        async remove(caminhos) { operacoes.push(['remove', ...caminhos]); return { error: null }; },
      }),
    },
  };
}

const ARQUIVOS = [
  `public/${A}-1790270883250.jpg`,
  `public/${A}-original-1790270883250.jpg`,
  `public/${A}-ai-dark-gold-1790272540534.png`,
  `public/${A}-ai-white-gold-1780000000000.png`,
  `tmp/${A}-1790272000000-pad.jpg`,
  `public/outra-pessoa-${A}.jpg`, // cita o id, mas não começa por ele: não é dela
  'public/ffffffff-0000-4000-8000-000000000000-1.jpg',
];

test('o plano: só public/ que COMEÇA pelo id da antiga; destino = o mesmo nome com o id da nova; tmp/ só listado', async () => {
  const cli = clienteFalso({ arquivos: ARQUIVOS });
  const { copias, temporarios } = await planejar(cli);
  assert.deepEqual(copias.map((c) => [c.de, c.para, c.jaExiste]), [
    [`public/${A}-1790270883250.jpg`, `public/${N}-1790270883250.jpg`, false],
    [`public/${A}-original-1790270883250.jpg`, `public/${N}-original-1790270883250.jpg`, false],
    [`public/${A}-ai-dark-gold-1790272540534.png`, `public/${N}-ai-dark-gold-1790272540534.png`, false],
    [`public/${A}-ai-white-gold-1780000000000.png`, `public/${N}-ai-white-gold-1780000000000.png`, false],
  ]);
  assert.deepEqual(temporarios, [`tmp/${A}-1790272000000-pad.jpg`]);
  assert.deepEqual(cli.operacoes, [], 'planejar não mexe em nada');
});

test('copiar: copia o que falta, pula o que já existe, nunca apaga; rodar de novo não copia nada', async () => {
  const cli = clienteFalso({ arquivos: [...ARQUIVOS, `public/${N}-1790270883250.jpg`] });
  const { copias } = await planejar(cli);
  assert.equal(copias.filter((c) => c.jaExiste).length, 1);
  assert.equal(await copiar(cli, copias), 3);
  for (const f of ARQUIVOS) assert.ok(cli.bucket.has(f), `o original ficou: ${f}`);
  assert.ok(!cli.operacoes.some((o) => o[0] === 'remove'), 'nada apagado');

  const segunda = await planejar(cli);
  assert.ok(segunda.copias.every((c) => c.jaExiste));
  assert.equal(await copiar(cli, segunda.copias), 0);
  assert.equal(cli.operacoes.filter((o) => o[0] === 'copy').length, 3);
});

test('contas que não batem com o mapa param antes de qualquer cópia', async () => {
  const cli = clienteFalso({ arquivos: ARQUIVOS, usuarios: [{ id: A, email: CONTAS.antiga.email }, { id: 'outro-id', email: CONTAS.nova.email }] });
  await assert.rejects(conferirContas(cli), /não tem o id do mapa/);
  await conferirContas(clienteFalso({ arquivos: ARQUIVOS }));
});

test('uma cópia que falha para com a mensagem de onde parou', async () => {
  const cli = clienteFalso({ arquivos: ARQUIVOS });
  const { copias } = await planejar(cli);
  cli.bucket.delete(copias[1].de);
  await assert.rejects(copiar(cli, copias), /rodar de novo continua daqui/);
  assert.ok(cli.bucket.has(copias[0].para), 'a primeira ficou copiada');
});
