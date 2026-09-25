// Rodada 28 (bloco E) — telemetria ANÔNIMA de velocidade.
//
// O que isto prova:
//   1. rotas e telas viram PADRÃO: slug de time, id, token, e-mail e número nunca passam;
//   2. a linha gravada só tem os campos da lista — um pedido cheio de identificadores (user id,
//      e-mail, IP, id de aparelho, token) grava uma linha sem nenhum deles, nem o valor escondido
//      noutro campo;
//   3. a rota responde 204 sem sessão, ignora o Authorization, recusa lixo com 400 e não grava nada;
//   4. no servidor de verdade, /api/telemetria conta no limiter PRÓPRIO (300/IP), fora dos gerais.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { normalizarRota, montarLinha, cabeNoTeto } = require('../utils/telemetria');
const { criarRotaTelemetria } = require('../routes/telemetria');

const CAMPOS_DA_LINHA = ['ambiente', 'tela', 'ms_util', 'chamadas', 'versao_app', 'plataforma', 'rede', 'aparelho'].sort();

const valido = () => ({
  tela: '/equipa/missa-de-quinta-ogqq6/ranking',
  ms_util: 812,
  chamadas: { '/api/teams/missa-de-quinta-ogqq6/ranking': { ms: 540, motor: 120 }, '/api/me/selos': 300 },
  versao_app: '1.0.0 (34)',
  plataforma: 'ios',
  rede: '4g',
  aparelho: 'ios-alto',
});

test('normalizarRota: slug de time, id, token, e-mail e número viram padrão', () => {
  const uuid = '5b1c2d3e-aaaa-4bbb-8ccc-0123456789ab';
  const casos = [
    ['/equipa/missa-de-quinta-ogqq6/ranking', '/equipa/:slug/ranking'],
    // slug SÓ de letras: passaria por palavra de rota — é a posição que o denuncia
    ['/equipa/teste-abcde', '/equipa/:slug'],
    [`/equipa/teste-abcde/jogador/${uuid}`, '/equipa/:slug/jogador/:id'],
    ['/admin/missa-de-quinta-ogqq6', '/admin/:slug'],
    ['/api/teams/missa-de-quinta-ogqq6/votos?desde=2026-09-01', '/api/teams/:slug/votos'],
    ['/api/equipas/abc-12xyz/campeonatos/42', '/api/equipas/:slug/campeonatos/:x'],
    [`/p/missa-de-quinta-ogqq6/${uuid}`, '/p/:slug/:id'],
    [`/p/campeonato/missa-de-quinta-ogqq6/${uuid}`, '/p/campeonato/:slug/:id'],
    [`/api/p/${uuid}`, '/api/p/:id'],
    ['/api/media/eyJhbGciOi.assinatura_longa', '/api/media/:x'],
    ['/api/users/joao@exemplo.com/perfil', '/api/users/:x/perfil'],
    ['/api/me/avatar/historico/12345', '/api/me/avatar/historico/:x'],
    ['/home', '/home'],
    ['/api/me/onboarding-completo', '/api/me/onboarding-completo'],
  ];
  for (const [de, para] of casos) assert.equal(normalizarRota(de), para, de);
});

test('montarLinha: só os campos da lista, com as rotas normalizadas', () => {
  const r = montarLinha(valido(), { ambiente: 'teste' });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(Object.keys(r.linha).sort(), CAMPOS_DA_LINHA);
  assert.equal(r.linha.tela, '/equipa/:slug/ranking');
  assert.deepEqual(r.linha.chamadas, {
    '/api/teams/:slug/ranking': { ms: 540, motor: 120 },
    '/api/me/selos': { ms: 300, motor: null },
  });
  assert.equal(r.linha.ambiente, 'teste');
});

test('montarLinha: pedido cheio de identificadores grava uma linha sem nenhum deles', () => {
  const pii = {
    user_id: '5b1c2d3e-aaaa-4bbb-8ccc-0123456789ab',
    userId: 'u-123',
    email: 'pessoa@exemplo.com',
    ip: '189.10.20.30',
    device_id: 'IDFA-0000-1111',
    token: 'eyJhbGciOiJIUzI1NiJ9.segredo',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7)',
  };
  const corpo = {
    ...valido(),
    ...pii,
    // identificadores escondidos nos campos que existem
    tela: `/equipa/${pii.email}/jogador/${pii.user_id}`,
    versao_app: pii.email,
    rede: pii.ip,
    aparelho: pii.device_id,
    chamadas: { [`/api/teams/missa/membros/${pii.user_id}`]: { ms: 10, motor: 5, email: pii.email }, 'https://evil.example/x': 99 },
  };
  const r = montarLinha(corpo, { ambiente: 'teste' });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(Object.keys(r.linha).sort(), CAMPOS_DA_LINHA);
  const gravado = JSON.stringify(r.linha);
  for (const [campo, valor] of Object.entries(pii)) {
    assert.ok(!gravado.includes(valor), `o valor de ${campo} entrou na linha: ${gravado}`);
  }
  assert.ok(!/@/.test(gravado), `um e-mail entrou na linha: ${gravado}`);
  assert.equal(r.linha.versao_app, null, 'versão com cara de e-mail devia virar null');
  assert.equal(r.linha.rede, null);
  assert.equal(r.linha.aparelho, null);
  assert.deepEqual(Object.keys(r.linha.chamadas), ['/api/teams/:slug/membros/:id'], 'rota de fora da API não devia entrar');
});

test('montarLinha: recusa o que não é medição', () => {
  const casos = [
    [null, 'corpo'],
    [[], 'corpo'],
    [{ ...valido(), tela: 'home' }, 'tela'],
    [{ ...valido(), tela: undefined }, 'tela'],
    [{ ...valido(), ms_util: -1 }, 'ms_util'],
    [{ ...valido(), ms_util: 999999 }, 'ms_util'],
    [{ ...valido(), ms_util: 1.5 }, 'ms_util'],
    [{ ...valido(), plataforma: 'windows' }, 'plataforma'],
  ];
  for (const [corpo, campo] of casos) {
    const r = montarLinha(corpo);
    assert.equal(r.ok, false, `devia recusar (${campo})`);
    assert.match(r.erro, new RegExp(campo));
  }
});

test('montarLinha: no máximo 20 rotas, a pior de cada padrão', () => {
  const chamadas = {};
  for (let i = 0; i < 30; i += 1) chamadas[`/api/rota-${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i >= 26 ? 'x' : ''}`] = i;
  chamadas['/api/teams/time-um-aaaaa/ranking'] = 100;
  chamadas['/api/teams/time-dois-bbbbb/ranking'] = 700; // mesmo padrão: fica o pior
  const r = montarLinha({ ...valido(), chamadas });
  assert.equal(r.ok, true);
  assert.ok(Object.keys(r.linha.chamadas).length <= 20);
  const r2 = montarLinha({ ...valido(), chamadas: { '/api/teams/time-um-aaaaa/ranking': 100, '/api/teams/time-dois-bbbbb/ranking': 700 } });
  assert.deepEqual(r2.linha.chamadas, { '/api/teams/:slug/ranking': { ms: 700, motor: null } });
});

test('cabeNoTeto: passa até o teto da janela e depois descarta', () => {
  const t0 = Date.UTC(2030, 0, 1); // janela nova, longe das dos outros testes
  let passaram = 0;
  for (let i = 0; i < 3100; i += 1) if (cabeNoTeto(t0 + 1)) passaram += 1;
  assert.equal(passaram, 3000);
  assert.equal(cabeNoTeto(t0 + 11 * 60 * 1000), true, 'a janela seguinte devia abrir de novo');
});

function appDeTeste(gravadas) {
  const app = express();
  app.use(express.json());
  app.use(criarRotaTelemetria({ gravar: async (linha) => { gravadas.push(linha); }, ambiente: 'teste', limite: (req, res, next) => next() }));
  return app;
}

async function postar(base, corpo, headers = {}) {
  return fetch(`${base}/api/telemetria`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(corpo) });
}

test('rota: 204 sem sessão; Authorization é ignorado e nada da sessão entra na linha', async (t) => {
  const gravadas = [];
  const servidor = appDeTeste(gravadas).listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const semSessao = await postar(base, valido());
  assert.equal(semSessao.status, 204);
  const comSessao = await postar(base, { ...valido(), tela: '/figurinha' }, { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.sessao-de-alguem' });
  assert.equal(comSessao.status, 204);

  assert.equal(gravadas.length, 2);
  for (const linha of gravadas) {
    assert.deepEqual(Object.keys(linha).sort(), CAMPOS_DA_LINHA);
    assert.ok(!JSON.stringify(linha).includes('sessao-de-alguem'));
  }
});

test('rota: lixo leva 400 e não grava nada', async (t) => {
  const gravadas = [];
  const servidor = appDeTeste(gravadas).listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const r = await postar(base, { tela: '/home', ms_util: 'rapido', plataforma: 'ios' });
  assert.equal(r.status, 400);
  assert.equal(gravadas.length, 0);
});

test('servidor: /api/telemetria conta no limiter próprio (300 por IP), fora dos gerais', async (t) => {
  const { app } = require('../server');
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  // Corpo inválido de propósito: prova a montagem e o limiter sem gravar nada no banco.
  const r = await postar(base, { tela: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('ratelimit-limit'), '300', 'a telemetria devia contar só no limiter dela');
  const outra = await fetch(`${base}/api/rota-inexistente-r28`);
  assert.notEqual(outra.headers.get('ratelimit-limit'), '300', 'o limiter geral continua valendo no resto da /api');
});
