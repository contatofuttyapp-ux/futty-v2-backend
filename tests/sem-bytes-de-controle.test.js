// Futty v2.0 — nenhum byte de controle no código do motor.
//
// Código editado pelo terminal (heredoc, `node -e`) perde as barras invertidas: o `\b` de uma regex vira o byte 0x08, que o editor não
// mostra, e a regex deixa de casar sem erro nenhum. Foi assim que a Resenha passou a ler todo time no fuso de São Paulo: o select pedia
// o fuso só se `/\bfuso\b/` casasse, e a regex corrompida nunca casava. Este teste varre o código e reprova qualquer byte de controle
// que não seja tab, LF ou CR — apontando arquivo e linha.
//
// Uso: npm test  (ou: node --test tests/sem-bytes-de-controle.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PASTAS_DE_FORA = new Set(['node_modules', '.git', 'public', 'uploads', 'coverage']);
const EXTENSOES = /\.(c|m)?js$|\.json$|\.sql$/;
const CONTROLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function arquivosDoCodigo(pasta) {
  const lista = [];
  for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!PASTAS_DE_FORA.has(e.name)) lista.push(...arquivosDoCodigo(path.join(pasta, e.name)));
    } else if (EXTENSOES.test(e.name)) {
      lista.push(path.join(pasta, e.name));
    }
  }
  return lista;
}

test('o código do motor não tem byte de controle (o \\b de uma regex que virou 0x08, por exemplo)', () => {
  const arquivos = arquivosDoCodigo(RAIZ);
  assert.ok(arquivos.some((a) => a.endsWith(path.join('routes', 'feed.js'))), 'a varredura chega às rotas');
  const achados = [];
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    if (!CONTROLE.test(texto)) continue;
    texto.split('\n').forEach((linha, i) => {
      const m = CONTROLE.exec(linha.replace(/\r$/, ''));
      if (m) achados.push(`${path.relative(RAIZ, arquivo)}:${i + 1} (byte 0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')})`);
    });
  }
  assert.deepEqual(achados, [], `byte de controle no código — reescreva a linha pelo editor, não pelo terminal:\n${achados.join('\n')}`);
});
