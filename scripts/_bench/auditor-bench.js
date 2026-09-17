// BANCADA DO AUDITOR — ronda 3: COMPETIÇÃO DE MODELOS DE VISÃO.
//
// Histórico:
//   r1: moondream2 reprovou TODAS (pergunta errada: exigia mão visível com
//       braços cruzados).
//   r2: pergunta certa, e o moondream2 APROVOU todas — inclusive as sem braço.
//       Pequeno demais: responde de memória ("pessoas têm braços"), não olha.
//   r3 (esta): mesmos 6 casos-gabarito do dono, modelos maiores em competição.
//       O any-llm/vision está marcado "deprecated" no fal mas pode ainda servir
//       — a sonda custa centavos e responde a dúvida de uma vez.
//
// Gabarito (30-jul, apontado pelo dono):
//   Denis--L2PB, Renato, Kim2  → defeito de braço  (REPROVAR)
//   Gui--L2P, foto-normal--L2P, prova-ruidosa--L2P → boas (PASSAR)
//
// Uso:  node scripts/_bench/auditor-bench.js

const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const CASOS = [
  ['saida-low/Denis--L2PB.png',        'Denis (sem braço)',    false],
  ['saida-producao/Renato.png',        'Renato (sem braço)',   false],
  ['saida-producao/Kim2.png',          'Kim2 (braço cortado)', false],
  ['saida-low/Gui--L2P.png',           'Gui (boa)',            true],
  ['saida-low/foto-normal--L2P.png',   'foto-normal (boa)',    true],
  ['saida-low/prova-ruidosa--L2P.png', 'prova-ruidosa (boa)',  true],
];

// Uma pergunta só, JSON estrito — modelos maiores aguentam.
const PROMPT_JSON = `You are a quality inspector for soccer trading-card illustrations.
Look carefully at the image and answer in STRICT JSON only, no other text:
{"one_person": true|false, "head_complete": true|false, "both_arms_complete": true|false, "sunglasses": true|false, "gold_trim_both_cuffs": true|false}

Definitions:
- head_complete: the top of the head/hair is fully drawn, not cut off or flattened.
- both_arms_complete: the person clearly has TWO arms, each drawn completely.
  Crossed arms, hands on hips or hidden hands still count as complete arms.
  Answer false ONLY if an arm is missing, amputated, cut by the image edge or
  fades away unfinished.
- sunglasses: true only for dark/opaque sunglasses.
- gold_trim_both_cuffs: the shirt shows a thin gold trim line at the end of BOTH sleeves.`;

// Candidatos. moondream fica como régua do barato.
const MODELOS = [
  { id: 'gemini-lite',  tipo: 'anyllm',    modelo: 'google/gemini-2.5-flash-lite' },
  { id: 'gemini-flash', tipo: 'anyllm',    modelo: 'google/gemini-2.5-flash' },
  { id: 'moondream',    tipo: 'moondream', modelo: null },
];

async function perguntarAnyLLM(modelo, imageUrl) {
  const r = await fal.subscribe('fal-ai/any-llm/vision', {
    input: {
      model: modelo,
      prompt: PROMPT_JSON,
      system_prompt: 'Answer with strict JSON only. No markdown, no explanations.',
      image_urls: [imageUrl],
      temperature: 0,
    },
  });
  const out = String(r?.output ?? '');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`sem JSON na resposta: ${out.slice(0, 60)}`);
  return JSON.parse(m[0]);
}

// moondream: JSON não dá; faz a pergunta única do braço (melhor da r2: b1).
async function perguntarMoondream(imageUrl) {
  const r = await fal.subscribe('fal-ai/moondream2/visual-query', {
    input: { image_url: imageUrl, prompt: 'Is one of the person\'s arms missing, amputated or cut off? Answer only yes or no.' },
  });
  const out = String(r?.output ?? '').trim().toLowerCase();
  return { one_person: true, head_complete: true, both_arms_complete: !/^yes/.test(out), sunglasses: false, gold_trim_both_cuffs: true };
}

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }

  const existentes = CASOS.filter(([f]) => fs.existsSync(path.join(__dirname, f)));
  if (!existentes.length) { console.error('Nenhum caso encontrado.'); process.exit(1); }

  console.log(`\nAUDITOR r3 — ${existentes.length} casos × ${MODELOS.length} modelos\n`);

  // sobe os casos uma vez
  const urls = [];
  const tmp = [];
  for (const [fich, rotulo, boa] of existentes) {
    const tp = `tmp-auditor/${path.basename(fich)}`;
    const { error } = await supabase.storage.from('kits').upload(tp, fs.readFileSync(path.join(__dirname, fich)), { contentType: 'image/png', upsert: true });
    if (error) { console.error(`${rotulo}: upload falhou`); continue; }
    tmp.push(tp);
    const { data: pub } = supabase.storage.from('kits').getPublicUrl(tp);
    urls.push({ url: `${pub.publicUrl}?v=${Date.now()}`, rotulo, boa });
  }

  const placar = {};
  const morto = {};

  for (const M of MODELOS) {
    if (morto[M.id]) continue;
    console.log(`--- ${M.id} ${M.modelo ? `(${M.modelo})` : ''} ---`);
    for (const { url, rotulo, boa } of urls) {
      let j;
      try {
        j = M.tipo === 'anyllm' ? await perguntarAnyLLM(M.modelo, url) : await perguntarMoondream(url);
      } catch (e) {
        console.error(`  ${rotulo}: ERRO ${e.message.slice(0, 70)}`);
        // endpoint morto → não insiste nos restantes casos deste modelo
        if (/404|not found|deprecated|无|unavailable/i.test(e.message)) { morto[M.id] = true; break; }
        continue;
      }
      const reprova = !j.one_person || !j.head_complete || !j.both_arms_complete;
      const veredicto = reprova ? 'REPROVA' : 'passa';
      const esperado = boa ? 'passa' : 'REPROVA';
      const certo = veredicto === esperado;
      placar[M.id] = (placar[M.id] || 0) + (certo ? 1 : 0);
      console.log(`  ${rotulo.padEnd(24)} bracos:${j.both_arms_complete} cabeca:${j.head_complete} oculos:${j.sunglasses} mangas:${j.gold_trim_both_cuffs} → ${veredicto.padEnd(7)} ${certo ? 'CERTO' : 'ERROU'}`);
    }
    console.log('');
  }

  if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});

  console.log('='.repeat(64));
  console.log('PLACAR FINAL:');
  for (const M of MODELOS) {
    console.log(`  ${M.id.padEnd(14)} ${morto[M.id] ? 'ENDPOINT MORTO' : `${placar[M.id] || 0}/${urls.length}`}`);
  }
  const vivo = MODELOS.filter((M) => !morto[M.id]).sort((a, b) => (placar[b.id] || 0) - (placar[a.id] || 0))[0];
  if (vivo && (placar[vivo.id] || 0) === urls.length) {
    console.log(`\nVENCEDOR: ${vivo.id} com ${urls.length}/${urls.length} → pronto para produção (pós-geração, regera 1x, nunca cobra defeito).`);
  } else {
    console.log(`\nNenhum modelo fez 100%. Melhor: ${vivo ? vivo.id : 'nenhum'} (${vivo ? placar[vivo.id] || 0 : 0}/${urls.length}). Plano B: verificação geométrica.`);
  }
  console.log('='.repeat(64));
})();
