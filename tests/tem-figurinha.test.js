// Futty v2.0 — RODADA 20 (achado da Rodada 19): tem_figurinha calculado no
// servidor. Antes, o frontend usava `!!kit_ativo` para decidir se mostra o
// interruptor "Mostrar minha foto/figurinha" — e kit_ativo||'dark-gold'
// (services/inicio.js) fazia TODA conta nova parecer que já tinha uma.
//
// Cobre os 2 casos do pedido: conta nova com foto (false) e demo-loja, que
// tem figurinha pronta mas NENHUMA linha em brilhantes_time/
// user_avatar_historico — só o avatar_url atual sendo IA (true).
//
// Uso: npm test  (ou: node --test tests/tem-figurinha.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const EMAIL_DEMO = 'demo-loja@futtymock.com';

let server;
let baseUrl;
let userId;
let accessToken;

const fotoDeTeste = (tom) => sharp({
  create: { width: 400, height: 600, channels: 3, background: { r: tom, g: tom, b: tom } },
}).jpeg({ quality: 92 }).toBuffer();

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-temfig-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error: criarErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (criarErr) throw criarErr;
  userId = criado.user.id;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  accessToken = entrou.session.access_token;

  const form = new FormData();
  form.append('avatar', new Blob([await fotoDeTeste(90)], { type: 'image/jpeg' }), 'foto.jpg');
  const res = await fetch(`${baseUrl}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form });
  if (res.status !== 200) throw new Error(`upload da foto de preparo falhou: ${res.status}`);
});

after(async () => {
  try {
    if (userId) {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: userId });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(userId)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
      await supabase.auth.admin.deleteUser(userId).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('conta nova com foto (sem figurinha nenhuma) -> GET /api/me tem_figurinha=false', async () => {
  // O PONTO do pedido: o interruptor não pode mais se basear em kit_ativo.
  // (kit_ativo em si pode chegar 'dark-gold' mesmo aqui — achado à parte,
  // registado no relatório: parece DEFAULT da COLUNA no banco, não algo que
  // este código escreva; services/inicio.js já não INVENTA mais o valor, só
  // não controla o que o Postgres devolve por trás.)
  const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const corpo = await res.json();
  assert.equal(res.status, 200, `GET /api/me falhou: ${JSON.stringify(corpo)}`);
  assert.equal(corpo.user.tem_figurinha, false, 'conta que só subiu foto não pode ter tem_figurinha=true');
});

test('demo-loja@futtymock.com (figurinha pronta, sem linha em brilhantes_time/historico) -> tem_figurinha=true', async (t) => {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const fs = require('node:fs');
  const path = require('node:path');
  const arqSenha = path.join(__dirname, '..', '..', '..', 'LOJA', 'demo-senha.txt');
  if (!fs.existsSync(arqSenha)) return t.skip('LOJA/demo-senha.txt não encontrado nesta máquina — pula (conta real, sem senha à mão).');
  const senha = fs.readFileSync(arqSenha, 'utf8').match(/senha: (.+)/)[1].trim();
  const { data: sess, error } = await anon.auth.signInWithPassword({ email: EMAIL_DEMO, password: senha });
  if (error) return t.skip(`login da demo-loja falhou (${error.message}) — pula.`);

  const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${sess.session.access_token}` } });
  const corpo = await res.json();
  assert.equal(res.status, 200);
  assert.equal(corpo.user.tem_figurinha, true, 'demo-loja tem figurinha pronta (avatar_url IA) — tem_figurinha tem de ser true');
});
