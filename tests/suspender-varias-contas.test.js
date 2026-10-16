// Futty v2.0 — Suspender várias contas no Gabinete: cada suspensão fica, independente das outras, e sobrevive a recarregar.
//
// O bug visto pelo dono: suspende a 1ª conta → "Suspensa"; suspende a 2ª → a 1ª volta a "Ativa" sozinha. A causa: as suspensões vivem num
// arquivo JSON no Storage (_plataforma/suspensoes.json) e cada suspensão lê o arquivo, acrescenta um id e grava de volta. O arquivo subia
// sem `cacheControl: '0'` (o padrão do Supabase é 1 h de cache no CDN) e era baixado sem furar o cache: a 2ª suspensão lia a versão
// GUARDADA NO CDN — de antes da 1ª — e gravava por cima. O Storage falso daqui faz o que o CDN faz: guarda a 1ª cópia baixada de um
// arquivo que pode ser guardado e a devolve até alguém pedir com `cacheNonce`.
//
// Uso: npm test  (ou: node --test tests/suspender-varias-contas.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const DONO = 'c3626394-6589-423e-ae6a-e71317366ec4';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const D = 'd0000000-0000-0000-0000-00000000000d';
const pessoa = (id, nome) => ({ id, nome, nome_jogador: nome, email: `${nome.toLowerCase()}@futtymock.com`, created_at: '2026-10-01T00:00:00Z', brilhante_creditos: 0 });

/** Um Storage com CDN na frente: o que foi gravado sem cacheControl '0' fica guardado na 1ª leitura e volta igual, até um cacheNonce. */
function storageComCdn({ falharLeitura = () => false } = {}) {
  const origem = new Map(); // caminho -> { corpo, cacheControl }
  const cdn = new Map(); // caminho -> corpo guardado
  const pedidos = [];
  return {
    origem, cdn, pedidos,
    from: (bucket) => ({
      async upload(caminho, corpo, opcoes = {}) {
        pedidos.push({ op: 'upload', caminho, cacheControl: opcoes.cacheControl });
        origem.set(`${bucket}/${caminho}`, { corpo: Buffer.from(corpo).toString('utf8'), cacheControl: opcoes.cacheControl ?? '3600' });
        return { data: { path: caminho }, error: null };
      },
      async download(caminho, opcoes = {}) {
        const chave = `${bucket}/${caminho}`;
        pedidos.push({ op: 'download', caminho, nonce: opcoes.cacheNonce ?? null });
        if (falharLeitura()) return { data: null, error: { message: 'Internal Server Error', status: 500, statusCode: '500' } };
        const furaCache = opcoes.cacheNonce != null;
        let corpo = !furaCache && cdn.has(chave) ? cdn.get(chave) : undefined;
        if (corpo === undefined) {
          const o = origem.get(chave);
          if (!o) return { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } };
          corpo = o.corpo;
          if (!furaCache && o.cacheControl !== '0') cdn.set(chave, corpo);
        }
        return { data: { text: async () => corpo }, error: null };
      },
    }),
  };
}

function cenario(storage) {
  const t = carregar({
    users: [pessoa(DONO, 'Chavo'), pessoa(A, 'Ana'), pessoa(B, 'Bia'), pessoa(C, 'Caio'), pessoa(D, 'Duda')].map((u) => (u.id === DONO ? { ...u, is_super_admin: true } : u)),
  }, ['routes/superadmin', 'utils/plataformaStore']);
  t.cliente.storage = storage;
  return t;
}

const suspensosNaLista = async (pedir) => {
  const r = await pedir('GET', '/api/super/users?page=1&limit=50', null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.users.filter((u) => u.suspenso).map((u) => u.nome).sort();
};

test('suspender 3 contas seguidas: as 3 ficam suspensas, também depois de recarregar (outra instância, cache vazio)', async (t) => {
  const storage = storageComCdn();
  const { carregados } = cenario(storage);
  const pedir = subir([carregados['routes/superadmin']], t);

  // o Gabinete abre a lista antes (é isto que põe o arquivo "velho" no CDN)
  assert.deepEqual(await suspensosNaLista(pedir), []);
  for (const id of [A, B, C]) {
    const r = await pedir('PATCH', `/api/super/users/${id}/suspender`, { suspenso: true }, DONO);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(await suspensosNaLista(pedir), [A, B, C].slice(0, [A, B, C].indexOf(id) + 1).map((x) => ({ [A]: 'Ana', [B]: 'Bia', [C]: 'Caio' })[x]).sort());
  }

  // "recarregar": outra instância do motor (módulos novos, cache em memória vazio) lendo o MESMO Storage
  const outra = cenario(storage);
  const pedirOutra = subir([outra.carregados['routes/superadmin']], t);
  assert.deepEqual(await suspensosNaLista(pedirOutra), ['Ana', 'Bia', 'Caio']);
  // e o que está gravado no Storage é a verdade, não só o cache de uma instância
  assert.deepEqual(JSON.parse(storage.origem.get('denuncias/_plataforma/suspensoes.json').corpo).users.sort(), [A, B, C].sort());
});

test('reativar uma das 3 não mexe nas outras duas', async (t) => {
  const storage = storageComCdn();
  const { carregados } = cenario(storage);
  const pedir = subir([carregados['routes/superadmin']], t);
  await suspensosNaLista(pedir);
  for (const id of [A, B, C]) assert.equal((await pedir('PATCH', `/api/super/users/${id}/suspender`, { suspenso: true }, DONO)).status, 200);
  assert.equal((await pedir('PATCH', `/api/super/users/${B}/suspender`, { suspenso: false }, DONO)).status, 200);
  assert.deepEqual(await suspensosNaLista(pedir), ['Ana', 'Caio']);
  const outra = cenario(storage);
  assert.deepEqual(await suspensosNaLista(subir([outra.carregados['routes/superadmin']], t)), ['Ana', 'Caio']);
});

test('o arquivo sobe sem cache no CDN e a leitura para gravar fura o cache', async (t) => {
  const storage = storageComCdn();
  const { carregados } = cenario(storage);
  const pedir = subir([carregados['routes/superadmin']], t);
  await pedir('PATCH', `/api/super/users/${A}/suspender`, { suspenso: true }, DONO);
  const uploads = storage.pedidos.filter((p) => p.op === 'upload');
  assert.ok(uploads.length && uploads.every((p) => p.cacheControl === '0'), JSON.stringify(uploads));
  const leituras = storage.pedidos.filter((p) => p.op === 'download');
  assert.ok(leituras.length && leituras.every((p) => p.nonce), JSON.stringify(leituras));
});

test('se a leitura antes de gravar falhar, nada é gravado (antes: lia "vazio" e apagava TODAS as suspensões)', async (t) => {
  let falhar = false;
  const storage = storageComCdn({ falharLeitura: () => falhar });
  const { carregados } = cenario(storage);
  const pedir = subir([carregados['routes/superadmin']], t);
  for (const id of [A, B]) assert.equal((await pedir('PATCH', `/api/super/users/${id}/suspender`, { suspenso: true }, DONO)).status, 200);
  falhar = true;
  const r = await pedir('PATCH', `/api/super/users/${C}/suspender`, { suspenso: true }, DONO);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.match(r.json.error, /suspens/i);
  assert.deepEqual(JSON.parse(storage.origem.get('denuncias/_plataforma/suspensoes.json').corpo).users.sort(), [A, B].sort());
});

test('o primeiro uso (arquivo ainda não existe) grava normalmente', async (t) => {
  const storage = storageComCdn();
  const { carregados } = cenario(storage);
  const pedir = subir([carregados['routes/superadmin']], t);
  assert.equal((await pedir('PATCH', `/api/super/users/${D}/suspender`, { suspenso: true }, DONO)).status, 200);
  assert.deepEqual(await suspensosNaLista(pedir), ['Duda']);
});
