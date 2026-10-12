// Futty v2.0 — SEGURANÇA · PENTEST DE ESCRITA: POST/PUT/PATCH/DELETE das rotas, com entrada maliciosa.
//
// O app de verdade (tests/_appFalsa.js) sobre banco, Storage e Auth de mentira — nada de banco real, nada de rede. Cada linha da tabela
// de rotas (tests/_linhasDeRotas.js) é atacada, no corpo e no endereço, por quem TEM permissão (para o pedido passar da porta e bater na
// validação de verdade):
//   · texto gigante (300 mil caracteres), HTML (`<img onerror>`, `<script>`, `<svg onload>`), `javascript:`, SQL, o `;` que o WAF recusa, NUL,
//     texto invertido, vazio e só espaços;
//   · número negativo, zero, absurdo, notação científica, "abc", "Infinity", placar 999;
//   · tipo errado (objeto, array, null, booleano) no lugar de texto e de número;
//   · o corpo inteiro torto (JSON quebrado, `[]`, `null`, texto, 2 MB+, content-type errado, `__proto__`);
//   · cada id do endereço trocado por lixo (`../`, NUL, aspas, tamanho absurdo).
// O que se exige de CADA resposta: nunca um 5xx com detalhe técnico (stack, tabela, SQL, caminho) — o 5xx, quando existe, é a frase da casa;
// sempre JSON com `nosniff`; e NADA gravado indevido: nenhuma string de mais de 20 mil caracteres chega ao banco ou ao Storage.
//
// Os 5xx que sobram (a frase da casa, sem detalhe, mas ainda 500 em vez de 400) ficam em CINCO_XX_CONHECIDOS: o teste reprova qualquer
// um NOVO e também reprova se um da lista tiver sido consertado e esquecido ali.
//
// Uso: node --test tests/seguranca-escrita.test.js     (RELATORIO_SEG=1 mostra o quadro dos 5xx e dos textos aceitos)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_appFalsa');
const { criarMundo, fotografiaDe } = require('./_mundoDeSeguranca');
const { LINHAS, CLASSES, desenho } = require('./_linhasDeRotas');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const FRASE_DA_CASA = 'Deu ruim do nosso lado. Tente de novo em instantes.';
const LIMITE_DE_TEXTO_GUARDADO = 20000;
const GIGANTE = 'A'.repeat(300000);

const ATAQUES_DE_TEXTO = {
  gigante: GIGANTE,
  img: '<img src=x onerror=alert(document.domain)>',
  script: '<script>alert(1)</script>',
  svg: '"><svg/onload=alert(1)>',
  javascript: 'javascript:alert(1)',
  sql: "'; DROP TABLE users; --",
  waf: 'a;cat /etc/passwd;',
  nul: 'oi\u0000tchau',
  invertido: '‮evil‬',
  vazio: '',
  espacos: '     ',
};
const ATAQUES_DE_NUMERO = { negativo: -1, zero: 0, enorme: 999999999999, cientifico: 1e308, abc: 'abc', infinito: 'Infinity', placar999: 999, fracao: 0.5 };
const ATAQUES_DE_TIPO = { objeto: { $ne: null }, array: [1, 2, 3], nulo: null, booleano: true, aninhado: { a: { b: { c: {} } } } };

// ─── Ferramentas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Todas as folhas (texto, número, booleano) do corpo, como caminhos: [['jogadores', 0, 'user_id'], ...]. */
function folhas(valor, caminho = []) {
  if (valor === null || typeof valor !== 'object') return [caminho];
  const chaves = Array.isArray(valor) ? valor.map((_, i) => i) : Object.keys(valor);
  return chaves.flatMap((k) => folhas(valor[k], [...caminho, k]));
}
function comValor(corpo, caminho, novo) {
  const copia = JSON.parse(JSON.stringify(corpo));
  let alvo = copia;
  for (const k of caminho.slice(0, -1)) alvo = alvo[k];
  alvo[caminho[caminho.length - 1]] = novo;
  return copia;
}

/** A maior string guardada em qualquer tabela ou em qualquer arquivo JSON do Storage. */
function maiorTextoGuardado() {
  let maior = { tamanho: 0, onde: '' };
  const ver = (valor, onde, profundidade = 0) => {
    if (profundidade > 30) return;
    if (typeof valor === 'string') { if (valor.length > maior.tamanho) maior = { tamanho: valor.length, onde }; return; }
    if (valor && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) ver(v, `${onde}.${k}`, profundidade + 1);
  };
  for (const [tabela, linhas] of Object.entries(app.tabelas)) linhas.forEach((l, i) => ver(l, `${tabela}[${i}]`));
  for (const [nome, b] of app.storage.buckets) {
    for (const [caminho, a] of b.arquivos) {
      if (!/json/.test(a.tipo) || caminho.startsWith('_diagnostico/')) continue; // o relatório de diagnóstico tem teto próprio: 512 KB, 10 por hora
      try { ver(JSON.parse(a.corpo.toString('utf8')), `storage:${nome}/${caminho}`); } catch { /* não era JSON */ }
    }
  }
  return maior;
}

const quemPassa = (linha) => (linha.permitidos || CLASSES[linha.classe].permitidos)[0];

function mundoComSuper() {
  const m = criarMundo(app);
  m.p.super = { id: '5ab00000-0000-4000-8000-000000000001', nome: 'Dono', nome_jogador: 'Dono', email: 'dono@futtymock.com' };
  app.tabelas.users.push({ ...m.p.super, is_super_admin: true });
  m.tok.super = app.abrirSessao(m.p.super);
  return m;
}

// O quadro do que o ataque encontrou, para o relatório.
const quadro = { cincoXX: new Map(), aceitos: new Map(), grandes: new Map() };
const anotar = (mapa, chave, detalhe) => { if (!mapa.has(chave)) mapa.set(chave, new Set()); mapa.get(chave).add(detalhe); };

/**
 * Confere uma resposta de ataque. Devolve o status. Reprova: 5xx com detalhe técnico, resposta que não é JSON, falta de nosniff.
 */
function conferir(r, contexto) {
  assert.match(r.cabecalhos.get('content-type') || '', /application\/json/, `${contexto} · a resposta não é JSON: ${r.texto.slice(0, 120)}`);
  assert.equal(r.cabecalhos.get('x-content-type-options'), 'nosniff', `${contexto} · falta X-Content-Type-Options: nosniff`);
  if (r.status >= 500) {
    assert.doesNotMatch(r.texto, /supabase|postgres|PGRST|violates|duplicate key|syntax error|stack|node_modules|[A-Z]:\\|\bat [\w.<>]+ \(|\.js:\d+/i, `${contexto} · detalhe técnico no ${r.status}: ${r.texto.slice(0, 200)}`);
    if (r.status === 500) assert.equal(r.json?.error, FRASE_DA_CASA, `${contexto} · 500 que não é a frase da casa: ${r.texto.slice(0, 200)}`);
  }
  return r.status;
}

// ─── 1. Entrada maliciosa no CORPO de cada rota ─────────────────────────────────────────────────────────────────────────────────

const COM_CORPO = LINHAS.filter((l) => l.corpo && !l.soSemLogin);

for (const linha of COM_CORPO) {
  test(`escrita · corpo · ${desenho(linha)}`, async () => {
    const base = mundoComSuper();
    const baseline = linha.corpo(base);
    const caminhosDasFolhas = folhas(baseline);
    // um mundo novo por folha atacada (os ataques mexem em dados: apagar, editar…)
    for (const caminho of caminhosDasFolhas.length ? caminhosDasFolhas : [[]]) {
      const original = caminho.length ? caminho.reduce((o, k) => o[k], baseline) : undefined;
      const ataques = [];
      if (typeof original === 'string' || original === undefined) for (const [nome, v] of Object.entries(ATAQUES_DE_TEXTO)) ataques.push([`texto:${nome}`, v]);
      if (typeof original === 'number' || typeof original === 'string') for (const [nome, v] of Object.entries(ATAQUES_DE_NUMERO)) ataques.push([`numero:${nome}`, v]);
      for (const [nome, v] of Object.entries(ATAQUES_DE_TIPO)) ataques.push([`tipo:${nome}`, v]);
      for (const [nome, valor] of ataques) {
        if (!caminho.length) break;
        const m = mundoComSuper();
        const corpo = comValor(linha.corpo(m), caminho, valor);
        const quem = quemPassa(linha);
        const r = await app.pedir(linha.metodo, linha.rota(m), { token: m.tok[quem], corpo });
        const contexto = `${linha.metodo} ${linha.rota(m)} · ${caminho.join('.')} = ${nome}`;
        const status = conferir(r, contexto);
        const rotulo = desenho(linha);
        if (status === 500) anotar(quadro.cincoXX, rotulo, `${caminho.join('.')}=${nome}`);
        if (status < 300 && nome.startsWith('texto:gigante')) anotar(quadro.aceitos, rotulo, `${caminho.join('.')} aceitou 300 mil caracteres`);
        const guardado = maiorTextoGuardado();
        if (guardado.tamanho > LIMITE_DE_TEXTO_GUARDADO) anotar(quadro.grandes, rotulo, `${caminho.join('.')}=${nome} → ${guardado.tamanho} caracteres em ${guardado.onde}`);
      }
    }
  });
}

// ─── 2. O corpo inteiro torto ────────────────────────────────────────────────────────────────────────────────────────────────────

const ESCRITAS_COM_CORPO = LINHAS.filter((l) => ['POST', 'PUT', 'PATCH'].includes(l.metodo) && !l.soSemLogin);
const CORPOS_TORTOS = [
  ['json-quebrado', { bruto: '{"a":' }],
  ['json-so-abre', { bruto: '{' }],
  ['array-vazio', { bruto: '[]' }],
  ['null', { bruto: 'null' }],
  ['texto', { bruto: '"oi"' }],
  ['numero', { bruto: '123' }],
  ['proto', { bruto: '{"__proto__":{"is_super_admin":true},"constructor":{"prototype":{"is_super_admin":true}},"nome":"x"}' }],
  ['mais-de-2mb', { bruto: `{"x":"${'A'.repeat(2300000)}"}` }],
  ['texto-puro', { bruto: 'nome=x', tipo: 'text/plain' }],
  ['formulario', { bruto: 'nome=x&__proto__[is_super_admin]=true&a[b][c]=1', tipo: 'application/x-www-form-urlencoded' }],
  ['charset-estranho', { bruto: '{"nome":"x"}', tipo: 'application/json; charset=utf-7' }],
  ['aninhado-fundo', { bruto: `${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}` }],
];

test('escrita · o corpo inteiro torto (JSON quebrado, tipo errado, 2 MB+, __proto__): nunca 5xx com detalhe, nunca poluição, e erro de cliente é 4xx', async () => {
  const sujos = [];
  for (const linha of ESCRITAS_COM_CORPO) {
    for (const [nome, extra] of CORPOS_TORTOS) {
      const m = mundoComSuper();
      const quem = quemPassa(linha);
      const eraSuper = !!app.tabelas.users.find((u) => u.id === m.p[quem]?.id)?.is_super_admin;
      const r = await app.pedir(linha.metodo, linha.rota(m), { token: m.tok[quem], ...extra });
      const contexto = `${linha.metodo} ${linha.rota(m)} · corpo ${nome}`;
      const status = conferir(r, contexto);
      assert.equal(({}).is_super_admin, undefined, `${contexto} · poluiu o Object.prototype`);
      assert.equal(!!app.tabelas.users.find((u) => u.id === m.p[quem]?.id)?.is_super_admin, eraSuper, `${contexto} · mudou o poder de super-admin da conta`);
      if (status === 500) sujos.push(`${desenho(linha)} ← ${nome}`);
      if (['json-quebrado', 'json-so-abre', 'mais-de-2mb'].includes(nome)) assert.ok(status >= 400 && status < 500, `${contexto} · erro de CLIENTE devia ser 4xx e deu ${status}`);
    }
  }
  assert.deepEqual(sujos, [], `corpos tortos que viram 5xx (a frase da casa, mas 500 em vez de 400):\n${sujos.join('\n')}`);
});

// ─── 3. Cada id do endereço trocado por lixo ─────────────────────────────────────────────────────────────────────────────────────

const LIXO_NO_ENDERECO = {
  traversal: '../../etc/passwd',
  traversal2: '..%2F..%2Fetc%2Fpasswd',
  nul: '%00',
  aspas: "'%20OR%201=1--",
  script: '%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  barra: '%2F',
  gigante: 'A'.repeat(5000),
  ponto: '.',
};

test('escrita · cada id do endereço trocado por lixo: nunca 5xx com detalhe, nunca 2xx, nada gravado', async () => {
  const sujos = [];
  for (const linha of LINHAS.filter((l) => !l.soSemLogin)) {
    const base = mundoComSuper();
    const valoresDoMundo = [base.A.slug, base.B.slug, ...Object.values(base.ids), ...Object.values(base.p).map((u) => u.id)];
    const segmentos = linha.rota(base).split('/');
    for (let i = 0; i < segmentos.length; i += 1) {
      if (!valoresDoMundo.includes(segmentos[i])) continue;
      for (const [nome, lixo] of Object.entries(LIXO_NO_ENDERECO)) {
        const m = mundoComSuper();
        const partes = linha.rota(m).split('/');
        partes[i] = lixo;
        const caminho = partes.join('/');
        const antes = fotografiaDe(app);
        const r = await app.pedir(linha.metodo, caminho, { token: m.tok[quemPassa(linha)], corpo: linha.corpo ? linha.corpo(m) : undefined });
        const contexto = `${linha.metodo} ${caminho.slice(0, 100)} (${nome})`;
        const status = conferir(r, contexto);
        if (status === 500) sujos.push(`${desenho(linha)} [segmento ${i}] ← ${nome} → ${status}`);
        // um id que não existe não pode "dar certo" nem gravar: só os pedidos sem efeito (200 de apagar o que não há) passam, e o mundo fica igual.
        // (As rotas da super gravam a suspensão pelo id que ela digita: é a dona, e o id só vira uma linha na lista de suspensos.)
        if (status < 300 && !['DELETE'].includes(linha.metodo) && linha.classe !== 'super') assert.equal(fotografiaDe(app), antes, `${contexto} · deu ${status} e gravou algo com um id de lixo`);
        assert.ok(!app.storage.operacoes.some((o) => o.caminho.includes('..')), `${contexto} · o motor pediu ao Storage um caminho com ../: ${JSON.stringify(app.storage.operacoes.find((o) => o.caminho.includes('..')))}`);
      }
    }
  }
  assert.deepEqual(sujos, [], `ids de lixo que viram 5xx:\n${sujos.join('\n')}`);
});

// ─── 4. O quadro ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// O que a varredura achou e ainda não é 400 (ver o relatório): a frase da casa, sem detalhe. Qualquer rota nova aqui reprova.
const CINCO_XX_CONHECIDOS = new Set([]);

test('escrita · quadro final: 5xx por entrada maliciosa, texto gigante guardado', () => {
  const imprimir = (titulo, mapa) => {
    console.log(`\n── ${titulo} (${mapa.size}) ──`);
    for (const [rota, detalhes] of [...mapa.entries()].sort()) console.log(`  ${rota}\n      ${[...detalhes].slice(0, 6).join('\n      ')}${detalhes.size > 6 ? `\n      … +${detalhes.size - 6}` : ''}`);
  };
  if (process.env.RELATORIO_SEG) {
    imprimir('rotas que dão 5xx (frase da casa) com entrada maliciosa no corpo', quadro.cincoXX);
    imprimir('rotas que aceitaram 300 mil caracteres', quadro.aceitos);
    imprimir('texto de mais de 20 mil caracteres guardado', quadro.grandes);
  }
  const novos = [...quadro.cincoXX.keys()].filter((r) => !CINCO_XX_CONHECIDOS.has(r));
  assert.deepEqual(novos, [], `rotas com 5xx por entrada maliciosa no corpo (ponha 400 na validação, ou anote em CINCO_XX_CONHECIDOS com o motivo):\n${novos.join('\n')}`);
  const esquecidos = [...CINCO_XX_CONHECIDOS].filter((r) => !quadro.cincoXX.has(r));
  assert.deepEqual(esquecidos, [], `rotas anotadas como 5xx que já não dão: tire de CINCO_XX_CONHECIDOS: ${esquecidos.join(', ')}`);
  const grandes = [...quadro.grandes.entries()].map(([r, d]) => `${r}: ${[...d][0]}`);
  assert.deepEqual(grandes, [], `texto gigante guardado indevidamente:\n${grandes.join('\n')}`);
  // A única saída de rede permitida é a consulta de cidade ao Nominatim (o geocodificador de verdade, host fixo); aqui a rede está fechada.
  const inesperadas = app.tentativasDeRede.filter((t) => !/nominatim\.openstreetmap\.org/.test(t));
  assert.deepEqual(inesperadas, [], `saiu pedido para a rede: ${inesperadas.join(', ')}`);
});
