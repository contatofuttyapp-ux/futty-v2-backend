// Futty — bancada da rodada "Fluidez 2" (16-set).
//
// Prova que GET /api/teams/:slug/jogador/:userId, depois de paralelizado, devolve
// BYTE A BYTE o mesmo corpo de antes. Mesma ideia da rodada "Velocidade 6A": a
// versão ANTIGA sai do git, a de AGORA sai do disco, as duas sobem no MESMO Express
// (em prefixos diferentes) e recebem o MESMO pedido, contra o banco de verdade.
//
//   cd C:\Users\phfer\Desktop\FUT\FUTTY-V2\backend
//   node scripts/bench-jogador-identico.js
//   node scripts/bench-jogador-identico.js --ref=HEAD~1        (depois de commitar)
//   node scripts/bench-jogador-identico.js --slug=... --viewer=email@x.com
//
// Antes de commitar, `--ref=HEAD` (o padrão) é a versão de antes, porque a de agora
// ainda está só na árvore de trabalho. Depois de commitar, aponte o ref para o
// commit anterior.
//
// A autenticação é a única coisa fingida: `requireAuth` passa a injetar o utilizador
// pedido (as contas de teste têm senha aleatória, não dá para pedir um JWT). Tudo o
// resto é o caminho real — requireTeamMember, ranking, banco em São Paulo.
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const express = require('express');

const RAIZ = path.resolve(__dirname, '..');
const CAMINHO_ROTA = path.join(RAIZ, 'routes', 'ranking.js');

const args = process.argv.slice(2);
const arg = (nome, omissao) => {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : omissao;
};
const REF = arg('ref', 'HEAD');
const SLUG = arg('slug', 'vila-olimpica-fc-demo-vila');
const VIEWER = arg('viewer', 'phferreiraborgesbackup@gmail.com');
const LIMITE = Number(arg('limite', '0')); // 0 = todos os membros do time

// ── Autenticação fingida: tem de ser plantada ANTES de qualquer rota carregar
// (routes/ranking.js desestrutura requireAuth no topo do módulo).
let utilizadorAtual = null;
const auth = require('../middleware/auth');
auth.requireAuth = (req, res, next) => { req.user = utilizadorAtual; next(); };

const { supabase } = require('../utils/db');
const { HttpError } = require('../utils/http');
const { tempoPorRota } = require('../middleware/tempo');

/** Compila um texto de módulo COMO SE fosse o ficheiro `caminho` — assim os
 *  require relativos (../utils/db, ./push) continuam a resolver, e nada precisa de
 *  ser escrito no disco nem entra no require.cache do ficheiro real. */
function compilarComo(codigo, caminho) {
  const mod = new Module(caminho, module);
  mod.filename = caminho;
  mod.paths = Module._nodeModulePaths(path.dirname(caminho));
  mod._compile(codigo, caminho);
  return mod.exports;
}

function versaoDoGit(ref) {
  const codigo = execFileSync('git', ['show', `${ref}:routes/ranking.js`], {
    cwd: RAIZ, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return compilarComo(codigo, CAMINHO_ROTA);
}

function montarServidor() {
  const app = express();
  app.use(tempoPorRota);
  app.use('/antes', versaoDoGit(REF));
  app.use('/agora', require('../routes/ranking'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : 500;
    const corpo = { error: err.message || 'Erro interno.' };
    if (err instanceof HttpError && err.code) corpo.code = err.code;
    res.status(status).json(corpo);
  });
  return app.listen(0);
}

async function pedir(porta, prefixo, userId) {
  const inicio = Date.now();
  const r = await fetch(`http://127.0.0.1:${porta}${prefixo}/api/teams/${SLUG}/jogador/${userId}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return { ms: Date.now() - inicio, status: r.status, bytes, timing: r.headers.get('server-timing') };
}

/** Onde os dois corpos divergem, com o pedaço à volta (para ler de olho). */
function ondeDiverge(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  const janela = (buf) => JSON.stringify(buf.slice(Math.max(0, i - 60), i + 60).toString('utf8'));
  return `byte ${i} de ${a.length}/${b.length}\n     antes: …${janela(a)}…\n     agora: …${janela(b)}…`;
}

(async () => {
  const { data: viewer } = await supabase.from('users').select('id, email').eq('email', VIEWER).maybeSingle();
  if (!viewer) throw new Error(`conta ${VIEWER} não existe no banco.`);
  const { data: time } = await supabase.from('teams').select('id, nome').eq('slug', SLUG).maybeSingle();
  if (!time) throw new Error(`time ${SLUG} não existe no banco.`);
  const { data: membros } = await supabase.from('team_members').select('user_id, users ( email )').eq('team_id', time.id);
  let alvos = (membros || []).map((m) => ({ id: m.user_id, email: m.users?.email || '?' }));
  if (LIMITE > 0) alvos = alvos.slice(0, LIMITE);

  utilizadorAtual = { id: viewer.id, email: viewer.email };
  const servidor = montarServidor();
  await new Promise((r) => servidor.once('listening', r));
  const porta = servidor.address().port;

  console.log(`Rota:   GET /api/teams/${SLUG}/jogador/:userId`);
  console.log(`Antes:  routes/ranking.js em ${REF} (git)   ·   Agora: a árvore de trabalho`);
  console.log(`Quem pede: ${viewer.email}   ·   Alvos: ${alvos.length} membros de "${time.nome}"\n`);

  let iguais = 0; const diferentes = []; const instaveis = [];
  let msAntes = 0; let msAgora = 0;
  let timingAgora = null;

  for (const alvo of alvos) {
    // Controlo: a versão antiga contra ela própria. Se ISTO já divergir, a rota não
    // é determinística e a comparação de baixo não significa nada.
    const a1 = await pedir(porta, '/antes', alvo.id);
    const a2 = await pedir(porta, '/antes', alvo.id);
    const b = await pedir(porta, '/agora', alvo.id);
    msAntes += a1.ms; msAgora += b.ms;
    timingAgora = timingAgora || b.timing;

    const estavel = a1.bytes.equals(a2.bytes);
    const igual = a1.bytes.equals(b.bytes);
    if (!estavel) instaveis.push(alvo.email);
    if (igual && a1.status === b.status) {
      iguais += 1;
      console.log(`  ✓ ${alvo.email.padEnd(34)} ${String(a1.bytes.length).padStart(6)} bytes  ${a1.status}  antes ${String(a1.ms).padStart(4)}ms → agora ${String(b.ms).padStart(4)}ms`);
    } else {
      diferentes.push(alvo.email);
      console.log(`  ✗ ${alvo.email} — status ${a1.status}/${b.status}, ${ondeDiverge(a1.bytes, b.bytes)}`);
    }
  }

  // Caminhos de erro: mudaram de onda (o 403 agora só se sabe depois da onda 2, o
  // 404 do jogador depois da onda 3) — o corpo tem de sair igual à mesma.
  const { data: forasteiro } = await supabase
    .from('users').select('id, email').like('email', 'demo-vila-wesley%').maybeSingle();
  const casos = [
    ['jogador que não existe (404)', viewer, '00000000-0000-4000-8000-000000000000'],
    forasteiro && ['quem não é membro do time (403)', forasteiro, alvos[0].id],
  ].filter(Boolean);
  for (const [nome, quem, alvoId] of casos) {
    utilizadorAtual = { id: quem.id, email: quem.email };
    const a = await pedir(porta, '/antes', alvoId);
    const b = await pedir(porta, '/agora', alvoId);
    const igual = a.status === b.status && a.bytes.equals(b.bytes);
    if (!igual) diferentes.push(nome);
    console.log(`  ${igual ? '✓' : '✗'} ${nome.padEnd(34)} ${a.status}/${b.status}  ${a.bytes.toString('utf8')}`);
  }
  utilizadorAtual = { id: viewer.id, email: viewer.email };

  console.log(`\nServer-Timing da versão de agora: ${timingAgora}`);
  console.log(`Tempo somado (${alvos.length} pedidos): antes ${msAntes} ms · agora ${msAgora} ms`);
  if (instaveis.length) console.log(`! a versão antiga divergiu DE SI PRÓPRIA em: ${instaveis.join(', ')}`);
  console.log(diferentes.length
    ? `\n✗ ${diferentes.length} de ${alvos.length} corpos DIFERENTES: ${diferentes.join(', ')}`
    : `\n✓ ${iguais} de ${alvos.length} corpos IDÊNTICOS byte a byte.`);

  await new Promise((r) => servidor.close(r));
  process.exit(diferentes.length ? 1 : 0);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
