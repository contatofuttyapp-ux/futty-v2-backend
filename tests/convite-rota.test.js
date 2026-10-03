// Futty v2.0 — RODADA 29A (item 11 e 1): GET /api/convite/:token abre rápido e devolve o logo do time.
//
// O que isto prova, SEM banco e SEM rede (Supabase falso em memória, injetado no cache de módulos antes de o
// routes/teams.js ser carregado — o mesmo truque de tests/direito-brilhante.test.js):
//   1. o time, quem convidou, os usos e o papel de quem abre saem JUNTOS (Promise.all): pico de 4 consultas
//      simultâneas e, com 60 ms por consulta, bem menos que as 5 idas em fila de antes;
//   2. o select do time pede logo_url e cor_fundo e a resposta os devolve (null quando o time não tem);
//   3. o contrato de sempre continua igual: válido/expirado/não encontrado, autenticado, jaMembro, usos, convidadoPor.
//
// RODADA 29B (A): a página do convite mostra três fatos — `membros` (contagem), `proximoJogo` (o próximo agendado, só a
// data) e `cidade` — e eles entram na MESMA leva paralela: 7 consultas juntas (6 sem sessão), ainda 2 idas no total.
// RODADA 29B (E): "N jogadores" não conta quem só organiza o time (team_members.joga = false).
//
// Uso: npm test  (ou: node --test tests/convite-rota.test.js)
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarSupabaseFalso } = require('./_supabaseFalso');

const TIME = '11111111-1111-1111-1111-111111111111';
const CONVITE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DONO = '33333333-3333-3333-3333-333333333333';
const MEMBRO = '44444444-4444-4444-4444-444444444444';
const FORA = '55555555-5555-5555-5555-555555555555';
const TOKEN = 'token-de-teste';
const AMANHA = new Date(Date.now() + 86400000).toISOString();
const ONTEM = new Date(Date.now() - 86400000).toISOString();
const SABADO = new Date(Date.now() + 3 * 86400000).toISOString();
const DOMINGO = new Date(Date.now() + 4 * 86400000).toISOString();

/** Envolve o cliente falso: atraso por consulta, pico de consultas em voo e os select() pedidos por tabela. */
function observar(cliente, atrasoMs = 0) {
  const obs = { emVoo: 0, pico: 0, consultas: [], selects: {} };
  const esperar = async () => {
    obs.emVoo += 1;
    obs.pico = Math.max(obs.pico, obs.emVoo);
    if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
  };
  const soltar = () => { obs.emVoo -= 1; };
  function embrulhar(tabela, b) {
    const proxy = new Proxy(b, {
      get(alvo, prop) {
        if (prop === 'then') {
          return (ok, falha) => esperar().then(() => alvo.then(ok, falha)).finally(soltar).then(ok && ((v) => v), falha);
        }
        const v = alvo[prop];
        if (typeof v !== 'function') return v;
        return (...args) => {
          if (prop === 'select') (obs.selects[tabela] ||= []).push(String(args[0] ?? ''));
          if (prop === 'maybeSingle' || prop === 'single') {
            return esperar().then(() => v.apply(alvo, args)).finally(soltar);
          }
          const r = v.apply(alvo, args);
          return r === alvo ? proxy : r;
        };
      },
    });
    return proxy;
  }
  const observado = {
    ...cliente,
    from(tabela) {
      obs.consultas.push(tabela);
      return embrulhar(tabela, cliente.from(tabela));
    },
  };
  return { cliente: observado, obs };
}

/** Sobe o router de equipas com o Supabase falso por baixo e devolve um `pedir(token, usuario)`. */
async function montar({ teams, atrasoMs = 0, convites = null, games = null, membros = null } = {}, t) {
  const { cliente: falso } = criarSupabaseFalso({
    convites: convites || [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: AMANHA }],
    teams: teams || [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: '#8b5cf6', logo_url: 'https://x.supabase.co/storage/v1/object/public/avatars/logos/t.png?v=1', cor_fundo: '#1a1a2e', cidade: 'Belo Horizonte' }],
    games: games || [],
    users: [{ id: DONO, nome: 'Antônio Silva', nome_jogador: 'Tonhão' }],
    convite_usos: [{ convite_id: CONVITE, user_id: MEMBRO }, { convite_id: CONVITE, user_id: FORA }],
    team_members: membros || [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: MEMBRO, role: 'member' }],
  });
  const { cliente, obs } = observar(falso, atrasoMs);

  const caminhoDb = require.resolve('../utils/db');
  const caminhoAlvo = require.resolve('../routes/teams');
  const dbAntigo = require.cache[caminhoDb];
  const getRole = async (teamId, userId) => {
    const { data } = await cliente.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    return data?.role || null;
  };
  require.cache[caminhoDb] = {
    id: caminhoDb, filename: caminhoDb, loaded: true, path: path.dirname(caminhoDb), children: [], paths: [],
    exports: {
      supabase: cliente,
      getRole,
      getTeamBySlug: async () => null,
      ensureUserRow: async () => {},
      requireTeamMember: async () => { throw new Error('não usado aqui'); },
    },
  };
  // O filtro de imagem (tensorflow) só serve ao upload do logo e custa ~7 s para carregar: aqui é um passa-adiante.
  const caminhoNsfw = require.resolve('../utils/nsfwFilter');
  const nsfwAntigo = require.cache[caminhoNsfw];
  const passaAdiante = (_req, _res, next) => next();
  require.cache[caminhoNsfw] = {
    id: caminhoNsfw, filename: caminhoNsfw, loaded: true, path: path.dirname(caminhoNsfw), children: [], paths: [],
    exports: { filtroNSFWFailClosed: passaAdiante, filtroNSFW: passaAdiante },
  };
  // Os módulos que guardam o `supabase` na hora do require (soOrganiza, o serviço do Início) têm de nascer de novo com o
  // falso DESTE cenário — senão o primeiro teste do processo prende o banco dele nos seguintes.
  const presos = ['../utils/soOrganiza', '../services/inicio'].map((m) => require.resolve(m));
  for (const p of presos) delete require.cache[p];
  delete require.cache[caminhoAlvo];
  // eslint-disable-next-line global-require
  const router = require('../routes/teams');
  delete require.cache[caminhoAlvo];
  for (const p of presos) delete require.cache[p];
  if (dbAntigo) require.cache[caminhoDb] = dbAntigo; else delete require.cache[caminhoDb];
  if (nsfwAntigo) require.cache[caminhoNsfw] = nsfwAntigo; else delete require.cache[caminhoNsfw];

  const app = express();
  app.use(express.json());
  // Quem abre o link: a rota tem o optionalAuth dela (sem token, segue anônimo); aqui só se põe o usuário.
  app.use((req, _res, next) => {
    const quem = req.get('x-teste-usuario');
    if (quem) req.user = { id: quem };
    next();
  });
  app.use(router);
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (token = TOKEN, usuario = null) => {
    const r = await fetch(`${base}/api/convite/${token}`, { headers: usuario ? { 'x-teste-usuario': usuario } : {} });
    return { status: r.status, json: await r.json() };
  };
  return { pedir, obs };
}

test('convite válido, anônimo: devolve o time COM logo_url e cor_fundo, quem convidou e os usos', async (t) => {
  const { pedir } = await montar({}, t);
  const { status, json } = await pedir();
  assert.equal(status, 200);
  assert.equal(json.valido, true);
  assert.equal(json.motivo, null);
  assert.equal(json.autenticado, false);
  assert.equal(json.jaMembro, false);
  assert.equal(json.convidadoPor, 'Tonhão');
  assert.equal(json.usos, 2);
  assert.deepEqual(json.team, {
    nome: 'Várzea FC',
    slug: 'varzea-fc',
    cor: '#8b5cf6',
    logo_url: 'https://x.supabase.co/storage/v1/object/public/avatars/logos/t.png?v=1',
    cor_fundo: '#1a1a2e',
    fuso: 'America/Sao_Paulo', // 29I (achado 83): o próximo jogo da página se lê no relógio do campo (time sem fuso = o padrão)
  });
  assert.equal(json.fuso, 'America/Sao_Paulo');
});

test('os três fatos da página: membros (contagem), cidade e próximo jogo (só a data, nunca o local)', async (t) => {
  const { pedir } = await montar({
    games: [
      { id: 'g-velho', team_id: TIME, data: ONTEM, status: 'terminado', local: 'Quadra velha' },
      { id: 'g-cancelado', team_id: TIME, data: SABADO, status: 'cancelado', local: 'Quadra cancelada' },
      { id: 'g-domingo', team_id: TIME, data: DOMINGO, status: 'agendado', local: 'Quadra do Zé' },
      { id: 'g-sabado', team_id: TIME, data: SABADO, status: 'agendado', local: 'Quadra do Tonhão' },
      { id: 'g-outro-time', team_id: FORA, data: new Date(Date.now() + 3600000).toISOString(), status: 'agendado' },
    ],
  }, t);
  const { json } = await pedir();
  assert.equal(json.membros, 2, 'DONO + MEMBRO');
  assert.equal(json.cidade, 'Belo Horizonte');
  assert.equal(json.proximoJogo, SABADO, 'o primeiro AGENDADO daqui pra frente: nem o passado, nem o cancelado, nem o de outro time');
  assert.ok(!JSON.stringify(json).includes('Quadra'), 'o local do jogo nunca sai por um link de convite');
});

test('"N jogadores" não conta quem só organiza o time', async (t) => {
  const { pedir } = await montar({
    membros: [
      { team_id: TIME, user_id: DONO, role: 'admin', joga: false }, // o dono só organiza
      { team_id: TIME, user_id: MEMBRO, role: 'member' },
      { team_id: TIME, user_id: FORA, role: 'member' },
    ],
  }, t);
  const { json } = await pedir();
  assert.equal(json.membros, 2, '3 membros, um só organiza');
});

test('time sem jogo agendado e sem cidade: proximoJogo e cidade vêm null, membros continua contando', async (t) => {
  const { pedir } = await montar({ teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }] }, t);
  const { json } = await pedir();
  assert.equal(json.proximoJogo, null);
  assert.equal(json.cidade, null);
  assert.equal(json.membros, 2);
});

test('o select do time pede logo_url, cor_fundo e cidade', async (t) => {
  const { pedir, obs } = await montar({}, t);
  await pedir();
  const doTime = (obs.selects.teams || []).join(' | ');
  assert.match(doTime, /logo_url/);
  assert.match(doTime, /cor_fundo/);
  assert.match(doTime, /cidade/);
});

test('time sem logo: logo_url e cor_fundo vêm null (a página cai nas iniciais)', async (t) => {
  const { pedir } = await montar({ teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }] }, t);
  const { json } = await pedir();
  assert.equal(json.team.logo_url, null);
  assert.equal(json.team.cor_fundo, null);
  assert.equal(json.team.nome, 'Várzea FC');
});

test('as consultas do time, de quem convidou, dos usos, do papel, da contagem, do próximo jogo e de quem só organiza saem JUNTAS (Promise.all)', async (t) => {
  const { pedir, obs } = await montar({ atrasoMs: 60 }, t);
  const inicio = Date.now();
  const { json } = await pedir(TOKEN, MEMBRO);
  const ms = Date.now() - inicio;
  assert.equal(json.jaMembro, true);
  assert.equal(obs.pico, 7, `pico de consultas simultâneas: ${obs.pico} (o convite vai sozinho, depois as sete juntas)`);
  // Em fila eram 5 idas (convite, time, quem convidou, usos, papel) = 300 ms só de atraso; juntas são 2 idas (120 ms).
  assert.ok(ms < 280, `levou ${ms} ms — devia ser ~2 idas de 60 ms, não 5`);
});

test('anônimo: o papel nem é consultado (6 consultas juntas; team_members só para a contagem)', async (t) => {
  const { pedir, obs } = await montar({ atrasoMs: 30 }, t);
  await pedir();
  assert.equal(obs.pico, 6);
  const dosMembros = (obs.selects.team_members || []).join(' | ');
  assert.ok(!/role/.test(dosMembros), 'sem sessão não há papel para ler — só a contagem toca team_members');
});

test('quem abre logado: membro → jaMembro true; quem não é → false; autenticado sempre true', async (t) => {
  const { pedir } = await montar({}, t);
  const membro = (await pedir(TOKEN, MEMBRO)).json;
  const fora = (await pedir(TOKEN, FORA)).json;
  assert.equal(membro.autenticado, true);
  assert.equal(membro.jaMembro, true);
  assert.equal(fora.autenticado, true);
  assert.equal(fora.jaMembro, false);
});

test('convite expirado: valido=false, motivo "expirado", e o time continua vindo (a tela mostra de quem era)', async (t) => {
  const { pedir } = await montar({ convites: [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: ONTEM }] }, t);
  const { json } = await pedir();
  assert.equal(json.valido, false);
  assert.equal(json.motivo, 'expirado');
  assert.equal(json.team.slug, 'varzea-fc');
});

test('token inexistente: nao_encontrado, team null, e nenhuma outra consulta além do convite', async (t) => {
  const { pedir, obs } = await montar({}, t);
  const { status, json } = await pedir('nao-existe');
  assert.equal(status, 200);
  assert.deepEqual(json, { valido: false, motivo: 'nao_encontrado', team: null });
  assert.deepEqual(obs.consultas, ['convites']);
});
