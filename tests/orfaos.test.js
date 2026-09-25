// Rodada 28 (bloco G) — a regra de quem é órfão no bucket `avatars` (utils/orfaos.js). Sem rede:
// o script scripts/limpar-orfaos.js só roda contra o Supabase real quando o Pedro pedir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acharOrfaos, resumirPorPasta } = require('../utils/orfaos');

const AGORA = Date.parse('2026-09-25T20:00:00Z');
const dias = (n) => new Date(AGORA - n * 24 * 60 * 60 * 1000).toISOString();
const horas = (n) => new Date(AGORA - n * 60 * 60 * 1000).toISOString();

test('órfão = ninguém aponta, com mais de 1 dia; tmp/ com mais de 1 hora', () => {
  const objetos = [
    { caminho: 'public/u1-100.jpg', criadoEm: dias(3), tamanho: 100 }, // a foto de agora: referenciada
    { caminho: 'public/u1-50.jpg', criadoEm: dias(3), tamanho: 200 }, // a foto antiga: faxina não terminou
    { caminho: 'public/u1-ai-dark-gold-9.png', criadoEm: dias(9), tamanho: 300 }, // slot de outro uniforme: referenciado
    { caminho: 'public/u2-200.jpg', criadoEm: horas(3), tamanho: 400 }, // novo demais: pode ser upload em curso
    { caminho: 'tmp/u1-1-pad.jpg', criadoEm: horas(2), tamanho: 50 }, // temporário velho
    { caminho: 'tmp/u1-2-pad.jpg', criadoEm: horas(0.2), tamanho: 50 }, // temporário da geração em curso
    { caminho: 'logos/t1.webp', criadoEm: dias(30), tamanho: 60 }, // logo do time: referenciado
    { caminho: 'public/sem-data.jpg', tamanho: 70 }, // sem data: não se toca
    { caminho: 'public/.emptyFolderPlaceholder', criadoEm: dias(99), tamanho: 0 },
  ];
  const referenciados = ['public/u1-100.jpg', 'public/u1-ai-dark-gold-9.png', 'logos/t1.webp'];
  const orfaos = acharOrfaos(objetos, referenciados, { agora: AGORA }).map((o) => o.caminho);
  assert.deepEqual(orfaos, ['public/u1-50.jpg', 'tmp/u1-1-pad.jpg']);
});

test('nada referenciado é órfão, por mais velho que seja', () => {
  const objetos = [{ caminho: 'public/x.jpg', criadoEm: dias(400) }];
  assert.deepEqual(acharOrfaos(objetos, ['public/x.jpg'], { agora: AGORA }), []);
});

test('resumo por pasta soma arquivos e bytes, maior primeiro', () => {
  const r = resumirPorPasta([
    { caminho: 'public/a.jpg', tamanho: 100 },
    { caminho: 'public/b.jpg', tamanho: 50 },
    { caminho: 'tmp/c.jpg', tamanho: 500 },
  ]);
  assert.deepEqual(r, [{ pasta: 'tmp', arquivos: 1, bytes: 500 }, { pasta: 'public', arquivos: 2, bytes: 150 }]);
});
