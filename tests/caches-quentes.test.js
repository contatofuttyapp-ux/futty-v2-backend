// Velocidade 6A (15-set) — o Storage sai do caminho quente.
//
// Três coisas liam/escreviam no Supabase Storage dentro de rotas que correm em
// cada abertura de tela:
//   · gabineteStore.ler()  → 1 download por /api/inicio E por /api/ads
//   · desfechos de denúncia → 1 `list` + 1 download POR FICHEIRO, por equipa
//   · adsStore.registar()  → read-modify-write do JSON inteiro por impressão
//
// Aqui tranca-se o comportamento das caches/acumulador SEM rede: os módulos são
// exercitados com o cliente do Supabase substituído por um espião que conta
// chamadas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Substitui utils/db no cache de módulos ANTES de carregar quem depende dele.
const caminhoDb = require.resolve('../utils/db');
const dbReal = require.cache[caminhoDb];
const MODULOS = ['../utils/adsStore', '../utils/gabineteStore', '../utils/plataformaStore'];

function comSupabaseFalso(fabrica, fn) {
  const espiao = fabrica();
  require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: { supabase: espiao.supabase } };
  // Limpa os módulos que capturam `supabase` no require.
  for (const m of MODULOS) {
    delete require.cache[require.resolve(m)];
  }
  try {
    return fn(espiao);
  } finally {
    if (dbReal) require.cache[caminhoDb] = dbReal; else delete require.cache[caminhoDb];
    for (const m of MODULOS) {
      delete require.cache[require.resolve(m)];
    }
  }
}

function espiaoStorage(conteudoInicial = {}) {
  const contas = { download: 0, upload: 0 };
  let guardado = Buffer.from(JSON.stringify(conteudoInicial));
  const supabase = {
    storage: {
      from() {
        return {
          async download() {
            contas.download += 1;
            const buf = guardado;
            return { data: { text: async () => buf.toString() } };
          },
          async upload(_caminho, buf) {
            contas.upload += 1;
            guardado = buf;
            return { error: null };
          },
        };
      },
    },
  };
  return { supabase, contas, lidoAgora: () => JSON.parse(guardado.toString()) };
}

test('gabineteStore.ler() só desce ao Storage uma vez dentro do TTL', async () => {
  await comSupabaseFalso(() => espiaoStorage({ ads_ativo: true }), async (espiao) => {
    const store = require('../utils/gabineteStore');
    await store.ler();
    await store.ler();
    await store.ler();
    assert.equal(espiao.contas.download, 1, 'a cache não segurou — seriam 3 downloads por 3 leituras');
  });
});

// Velocidade 7A: o arranque frio do app manda 3 pedidos juntos.
test('3 leituras simultâneas do gabinete → 1 download só', async () => {
  await comSupabaseFalso(() => espiaoStorage({ ads_ativo: true }), async (espiao) => {
    const store = require('../utils/gabineteStore');
    await Promise.all([store.ler(), store.ler(), store.ler()]);
    assert.equal(espiao.contas.download, 1, 'cada pedido baixou o arquivo sozinho (manada)');
  });
});

test('3 checagens simultâneas de suspensão → 1 download só', async () => {
  await comSupabaseFalso(() => espiaoStorage({ users: ['u-suspenso'], equipas: [] }), async (espiao) => {
    const plataforma = require('../utils/plataformaStore');
    const r = await Promise.all([
      plataforma.userSuspenso('u-suspenso'),
      plataforma.userSuspenso('u-livre'),
      plataforma.equipaSuspensa('t-1'),
    ]);
    assert.deepEqual(r, [true, false, false]);
    assert.equal(espiao.contas.download, 1, 'cada pedido baixou as suspensões sozinho (manada)');
  });
});

test('gravar() faz a leitura seguinte devolver já o valor novo', async () => {
  await comSupabaseFalso(() => espiaoStorage({ ads_ativo: true }), async () => {
    const store = require('../utils/gabineteStore');
    await store.ler();
    await store.gravar({ ads_ativo: false, campanhas: [] });
    const depois = await store.ler();
    assert.equal(depois.ads_ativo, false, 'o dono gravou e continuou a ver o valor antigo');
  });
});

test('invalidar() obriga a próxima leitura a descer ao Storage', async () => {
  await comSupabaseFalso(() => espiaoStorage({ ads_ativo: true }), async (espiao) => {
    const store = require('../utils/gabineteStore');
    await store.ler();
    assert.equal(espiao.contas.download, 1);
    store.invalidar();
    await store.ler();
    assert.equal(espiao.contas.download, 2);
  });
});

test('adsStore.registar() não toca no Storage — só o flush toca', async () => {
  await comSupabaseFalso(() => espiaoStorage({}), async (espiao) => {
    const ads = require('../utils/adsStore');
    for (let i = 0; i < 20; i += 1) ads.registar('campanha-1', 'imp');
    ads.registar('campanha-1', 'cli');
    assert.equal(espiao.contas.download, 0, 'uma impressão desceu ao Storage');
    assert.equal(espiao.contas.upload, 0, 'uma impressão escreveu no Storage');

    await ads.descarregar();
    assert.equal(espiao.contas.upload, 1, 'o flush devia escrever UMA vez, não 21');

    const dia = new Date().toISOString().slice(0, 10);
    const m = espiao.lidoAgora();
    assert.equal(m['campanha-1'].dias[dia].imp, 20);
    assert.equal(m['campanha-1'].dias[dia].cli, 1);
  });
});

test('o flush soma ao que já estava gravado (não sobrepõe)', async () => {
  const dia = new Date().toISOString().slice(0, 10);
  const inicial = { 'campanha-1': { dias: { [dia]: { imp: 100, cli: 5 } } } };
  await comSupabaseFalso(() => espiaoStorage(inicial), async (espiao) => {
    const ads = require('../utils/adsStore');
    ads.registar('campanha-1', 'imp');
    ads.registar('campanha-1', 'imp');
    await ads.descarregar();
    const m = espiao.lidoAgora();
    assert.equal(m['campanha-1'].dias[dia].imp, 102, 'as contagens antigas foram perdidas');
    assert.equal(m['campanha-1'].dias[dia].cli, 5);
  });
});

test('flush sem nada pendente não escreve', async () => {
  await comSupabaseFalso(() => espiaoStorage({}), async (espiao) => {
    const ads = require('../utils/adsStore');
    await ads.descarregar();
    assert.equal(espiao.contas.upload, 0);
  });
});
