// ═══════════════════════════════════════════════════════════════════════════════
// PROVA DE PRODUÇÃO REAL — uma figurinha pelo caminho de verdade (17-set).
//
// Não é bancada: isto chama a ROTA (`POST /api/me/avatar/ai`) com a sessão da
// conta demo da loja, e por isso exercita tudo o que mudou de uma vez —
// prompts/figurinha.js, a entrada quadrada, input_fidelity explícito, a fila da
// fal com leitura do custo, e a gravação em `gasto_ia_diario`.
//
// O que se prova: que a linha do dia ganha o custo REAL (~11 cêntimos), não a
// constante de 1,7 que estava lá antes.
//
//   node scripts/_bench/prova-figurinha-real.js            (servidor em :3009)
//   --porta 3009     onde o servidor de prova está a ouvir
//   --kit dark-gold
//
// Antes de gerar, desarma os dois atalhos que impediriam a geração: o slot do
// kit (a conta demo já tem figurinha) e a quota do mês. Repõe a quota no fim.
// Custo: uma geração (~US$0,112); se a rede de segurança reprovar a 1ª imagem,
// o retry da própria produção gera outra e o dobro é cobrado — o script diz.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');

const SAIDA = path.join(__dirname, 'saida-producao');
const EMAIL = 'demo-loja@futtymock.com';
const ARQUIVO_SENHA = path.join(__dirname, '..', '..', '..', '..', 'LOJA', 'demo-senha.txt');
const arg = (n, o) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : o; };

/** Achatamento da coroa (CLAUDE.md): ~0 cúpula normal; > 0,5 cabeça comida. */
async function achatamento(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const larg = (y) => { let n = 0; for (let x = 0; x < w; x += 1) if (data[(y * w + x) * c + 3] > 200) n += 1; return n; };
  let y0 = -1;
  for (let y = 0; y < h && y0 < 0; y += 1) if (larg(y) > 0) y0 = y;
  if (y0 < 0) return { razao: null, cortada: false };
  const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
  let maxima = 0;
  for (let y = y0; y < faixa; y += 1) maxima = Math.max(maxima, larg(y));
  const razao = maxima ? larg(y0) / maxima : 0;
  return { razao, cortada: razao > 0.5 };
}

const hoje = () => new Date().toISOString().slice(0, 10);
const lerGasto = async () => {
  const { data } = await supabase.from('gasto_ia_diario').select('geracoes, custo_cents').eq('dia', hoje()).maybeSingle();
  return { geracoes: data?.geracoes || 0, custo_cents: data?.custo_cents || 0 };
};

(async () => {
  const porta = arg('porta', '3009');
  const kitId = arg('kit', 'dark-gold');
  const base = `http://localhost:${porta}`;
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }
  if (!fs.existsSync(ARQUIVO_SENHA)) { console.error(`Senha da conta demo não encontrada: ${ARQUIVO_SENHA}`); process.exit(1); }
  // O ficheiro é 'e-mail: …' / 'senha: …' — a senha é o que vem depois dos dois
  // pontos na última linha com texto (mesma leitura do ver-iphone.mjs do frontend).
  const bruto = fs.readFileSync(ARQUIVO_SENHA, 'utf8');
  const linha = bruto.split(new RegExp(String.fromCharCode(92,114,63,92,110))).map((l) => l.trim()).filter(Boolean).pop() || '';
  const senha = linha.includes(':') ? linha.split(':').pop().trim() : linha;

  // O servidor tem de estar de pé — senão isto não prova nada.
  const saude = await fetch(`${base}/api/health`).catch(() => null);
  if (!saude?.ok) { console.error(`Servidor não responde em ${base}. Sobe-o com PORT=${porta} node server.js`); process.exit(1); }

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: sessao, error: errLogin } = await auth.auth.signInWithPassword({ email: EMAIL, password: senha });
  if (errLogin) { console.error('login da conta demo falhou:', errLogin.message); process.exit(1); }
  const token = sessao.session.access_token;
  const userId = sessao.user.id;
  console.log(`conta demo ok · ${EMAIL}`);

  // Desarmar os atalhos: o slot deste kit e a quota do mês.
  const { data: antesUser } = await supabase.from('users').select('avatar_ia_mes, plan').eq('id', userId).maybeSingle();
  await supabase.from('user_avatar_slots').delete().eq('user_id', userId).eq('kit_id', kitId);
  await supabase.from('users').update({ avatar_ia_mes: 0 }).eq('id', userId);
  console.log(`slot do kit ${kitId} apagado e quota do mês zerada (estava em ${antesUser?.avatar_ia_mes ?? '?'}, plano ${antesUser?.plan || 'free'})`);

  const antes = await lerGasto();
  console.log(`gasto_ia_diario ANTES: ${antes.geracoes} gerações · ${antes.custo_cents} cents`);

  console.log('\na gerar (isto demora ~30 s e custa dinheiro real)...');
  const t0 = Date.now();
  const r = await fetch(`${base}/api/me/avatar/ai`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kit: kitId }),
  });
  const corpo = await r.json().catch(() => ({}));
  const segundos = (Date.now() - t0) / 1000;
  if (!r.ok) {
    console.error(`FALHOU ${r.status}:`, corpo);
    await supabase.from('users').update({ avatar_ia_mes: antesUser?.avatar_ia_mes ?? 0 }).eq('id', userId);
    process.exit(1);
  }
  console.log(`geração OK em ${segundos.toFixed(0)}s · reutilizado: ${corpo.reutilizado} · do slot: ${corpo.do_slot}`);
  if (corpo.reutilizado || corpo.do_slot) {
    console.error('ATENÇÃO: veio do slot, não gerou nada — a prova não vale.');
    process.exit(1);
  }

  // O gasto do dia tem de ter subido com o custo REAL.
  await new Promise((s) => setTimeout(s, 2500)); // registrarGeracao é fire-and-forget
  const depois = await lerGasto();
  const deltaGer = depois.geracoes - antes.geracoes;
  const deltaCents = depois.custo_cents - antes.custo_cents;
  console.log(`gasto_ia_diario DEPOIS: ${depois.geracoes} gerações · ${depois.custo_cents} cents`);
  console.log(`→ esta geração somou ${deltaGer} geração e ${deltaCents} cents (US$${(deltaCents / 100).toFixed(2)})`);

  // A figurinha em si: baixar, medir, guardar.
  fs.mkdirSync(SAIDA, { recursive: true });
  // O caminho vem do `avatar_url` que a rota devolveu — desde 22-set o nome do
  // ficheiro leva carimbo de tempo (`public/<id>-ai-<kit>-<carimbo>.png`) e já
  // não dá para o adivinhar aqui. Este é também o caminho que o resto do app
  // usa: se a prova o lê do mesmo sítio, prova a mesma coisa que o app vê.
  const marcador = '/object/public/avatars/';
  const caminho = String(corpo.avatar_url || '').includes(marcador)
    ? corpo.avatar_url.slice(corpo.avatar_url.indexOf(marcador) + marcador.length).split('?')[0]
    : null;
  if (!caminho) {
    console.error('a resposta não trouxe um avatar_url do bucket avatars:', corpo.avatar_url);
    process.exit(1);
  }
  const { data: blob, error: errDl } = await supabase.storage.from('avatars').download(caminho);
  let ach = { razao: null };
  let destino = '(não baixada)';
  if (errDl) {
    console.error('não consegui baixar a figurinha do Storage:', errDl.message);
  } else {
    const buf = Buffer.from(await blob.arrayBuffer());
    destino = path.join(SAIDA, `prova-real-${hoje()}-${kitId}.png`);
    fs.writeFileSync(destino, buf);
    ach = await achatamento(await sharp(buf).trim({ threshold: 10 }).png().toBuffer());
    const m = await sharp(buf).metadata();
    console.log(`figurinha ${m.width}x${m.height} · ${(buf.length / 1024).toFixed(0)} KB · achatamento ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : ''}`);
    console.log(`guardada em ${destino}`);
  }

  // Repor a quota como estava — a prova não pode custar uma geração à conta demo.
  await supabase.from('users').update({ avatar_ia_mes: antesUser?.avatar_ia_mes ?? 0 }).eq('id', userId);

  const ok = deltaGer === 1 && deltaCents >= 5 && deltaCents <= 40 && !ach.cortada;
  console.log(`\n${'='.repeat(70)}`);
  console.log(ok ? 'PROVA OK' : 'PROVA COM RESSALVAS', `— custo real gravado: ${deltaCents} cents`);
  console.log(`  ${deltaGer === 1 ? 'ok ' : 'ERRO'} gerações +1`);
  console.log(`  ${deltaCents >= 5 && deltaCents <= 40 ? 'ok ' : 'ERRO'} custo entre 5 e 40 cents (a constante antiga dava 2)`);
  console.log(`  ${!ach.cortada ? 'ok ' : 'ERRO'} cabeça inteira (achatamento ${ach.razao === null ? '—' : ach.razao.toFixed(2)})`);
  console.log('='.repeat(70));
  process.exit(ok ? 0 : 1);
})();
