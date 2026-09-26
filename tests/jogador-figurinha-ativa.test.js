// Manutenção 26-set (item D.10) — GET /api/teams/:slug/jogador/:userId decidia
// foto × figurinha pela regra antiga (avatar_url !== foto_url), aposentada no Hotfix 26 por
// causa da foto do Google (mesmo bug de tests/figurinha-ativa.test.js). Este endpoint ficou de
// fora daquela rodada; agora devolve `jogador.figurinha_ativa` pela regra única
// (utils/figurinhaRegra.js), igual ao que services/inicio.js já fazia no /api/me.
//
// Cria time/jogos/conta próprios e apaga tudo no fim (mesmo padrão de goleiro-do-time.test.js).
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
let teamId;
let teamSlug;
let userId;
let token;
const gameIds = [];

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env.');
  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-jogfigativa-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userId = created.user.id;
  await supabase.from('users').upsert({ id: userId, email, nome: 'Teste Jogador' }, { onConflict: 'id' });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessao, error: erroSessao } = await anon.auth.signInWithPassword({ email, password });
  if (erroSessao) throw erroSessao;
  token = sessao.session.access_token;

  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  teamSlug = `teste-jogfigativa-${sufixo}`;
  const { data: time, error: teamErr } = await supabase
    .from('teams')
    .insert({ nome: `Teste FigAtiva ${sufixo}`, slug: teamSlug, cor: 'verde', criado_por: userId })
    .select()
    .single();
  if (teamErr) throw teamErr;
  teamId = time.id;

  const { error: memErr } = await supabase.from('team_members').insert({ team_id: teamId, user_id: userId, role: 'admin', categoria: 'linha' });
  if (memErr) throw memErr;

  // MIN_JOGOS (buildRanking) exige 3 jogos com presença confirmada para o jogador entrar no
  // ranking — sem isto, GET .../jogador/:userId dá 404 ("Jogador não encontrado neste time").
  const daquiADias = (n) => new Date(Date.now() + n * 864e5).toISOString();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data: jogo, error: gameErr } = await supabase
      .from('games')
      .insert({ team_id: teamId, data: daquiADias(3 + i), local: 'Quadra de Teste', status: 'terminado' })
      .select()
      .single();
    if (gameErr) throw gameErr;
    gameIds.push(jogo.id);
    // eslint-disable-next-line no-await-in-loop
    const { error: gpErr } = await supabase.from('game_players').insert({ game_id: jogo.id, user_id: userId, confirmado: true });
    if (gpErr) throw gpErr;
  }
});

after(async () => {
  if (!COM_BANCO) return;
  try {
    for (const id of gameIds) await supabase.from('games').delete().eq('id', id);
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    if (userId) {
      await supabase.from('users').delete().eq('id', userId);
      await supabase.auth.admin.deleteUser(userId).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

const buscarJogador = async () => {
  const r = await fetch(`${baseUrl}/api/teams/${teamSlug}/jogador/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
  const corpo = await r.json();
  assert.equal(r.status, 200, JSON.stringify(corpo));
  return corpo.jogador;
};

test('sem avatar IA: figurinha_ativa false', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const jogador = await buscarJogador();
  assert.equal(jogador.figurinha_ativa, false);
});

test('foto do Google em avatar_url (≠ foto_url): false — a regra antiga dizia true', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  await supabase.from('users').update({ avatar_url: 'https://lh3.googleusercontent.com/a/foto-do-google=s96-c', foto_url: null }).eq('id', userId);
  const jogador = await buscarJogador();
  assert.equal(jogador.figurinha_ativa, false, 'a foto do Google virou "figurinha" de novo');
});

test('arquivo -ai- do nosso bucket em avatar_url: true', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const caminho = `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${userId}-ai-dark-gold-1.png?v=1`;
  await supabase.from('users').update({ avatar_url: caminho }).eq('id', userId);
  const jogador = await buscarJogador();
  assert.equal(jogador.figurinha_ativa, true);
});
