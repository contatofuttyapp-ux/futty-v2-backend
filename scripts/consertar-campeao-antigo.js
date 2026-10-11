#!/usr/bin/env node
// Futty v2.0 — Conserta os jogos antigos que têm `time_vencedor` e não têm `campeao_time_index` (Rodada 30I).
//
// Antes de o campeão ser a verdade, a tela do jogo gravava só `time_vencedor` ('A' | 'B'); esses jogos ficaram sem post na Resenha e fora das conquistas
// do perfil. Este script preenche o campeão a partir do vencedor (A → 0, B → 1). A decisão e a regra estão em utils/consertoDoCampeao.js.
//
// ⚠️ Fala com o Supabase DE VERDADE (o do .env) — hoje ele é o mesmo do site. Por padrão é MODO SECO: só lê e mostra o que faria, nada é gravado.
//
// Uso (na pasta backend):
//   node scripts/consertar-campeao-antigo.js          modo seco: quantos jogos seriam afetados, por time, e os que ficam de fora
//   node scripts/consertar-campeao-antigo.js --sim    grava de verdade (só onde o campeão ainda está vazio)
//
// Idempotente: rodar de novo depois do --sim não acha mais nada para consertar. Rodar no publica da 30I (junto das telas), antes de a Resenha ser olhada.
require('dotenv').config({ quiet: true });
const { supabase } = require('../utils/db');
const { executarConserto } = require('../utils/consertoDoCampeao');

const SIM = process.argv.includes('--sim');
const AMOSTRA = 15;

const nomeDe = (id, times) => times.get(id) || id;

async function main() {
  console.log(SIM ? '▶ GRAVANDO (--sim)' : '▶ MODO SECO — nada será gravado (use --sim para gravar)');
  const { plano, semComoDerivar, gravados, falhas } = await executarConserto(supabase, { sim: SIM });

  const ids = [...new Set([...plano.conserta, ...plano.semTimes, ...plano.divergentes].map((j) => j.team_id))];
  const times = new Map();
  if (ids.length) {
    const { data } = await supabase.from('teams').select('id, slug').in('id', ids);
    for (const t of data || []) times.set(t.id, t.slug);
  }
  const porTime = {};
  for (const j of plano.conserta) porTime[nomeDe(j.team_id, times)] = (porTime[nomeDe(j.team_id, times)] || 0) + 1;

  console.log('');
  console.log(`Jogos com time_vencedor A/B e SEM campeão (seriam consertados): ${plano.conserta.length}`);
  for (const [slug, n] of Object.entries(porTime).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${slug}`);
  for (const j of plano.conserta.slice(0, AMOSTRA)) console.log(`   · ${j.id}  ${String(j.data || '').slice(0, 10)}  ${nomeDe(j.team_id, times)}  ${j.time_vencedor} → campeão ${j.campeao_time_index}`);
  if (plano.conserta.length > AMOSTRA) console.log(`   … e mais ${plano.conserta.length - AMOSTRA}`);
  console.log(`Já certos (campeão preenchido e igual ao vencedor): ${plano.jaCertos}`);
  console.log(`Ficam de fora — vencedor A/B mas o jogo não tem os times (nada a que apontar): ${plano.semTimes.length}`);
  for (const j of plano.semTimes.slice(0, AMOSTRA)) console.log(`   · ${j.id}  ${String(j.data || '').slice(0, 10)}  ${nomeDe(j.team_id, times)}`);
  console.log(`Ficam de fora — campeão já preenchido e DIFERENTE do vencedor (o campeão manda; só informo): ${plano.divergentes.length}`);
  for (const j of plano.divergentes.slice(0, AMOSTRA)) console.log(`   · ${j.id}  ${String(j.data || '').slice(0, 10)}  ${nomeDe(j.team_id, times)}  vencedor ${j.time_vencedor}, campeão ${j.campeao_time_index}`);
  console.log(`Ficam de fora — resultado só com gols/nível, sem vencedor nem campeão (não há de onde derivar): ${semComoDerivar}`);

  if (SIM) {
    console.log('');
    console.log(`✓ gravados: ${gravados} de ${plano.conserta.length}`);
    for (const f of falhas) console.log(`✗ ${f.id}: ${f.erro}`);
    if (falhas.length) process.exitCode = 1;
  } else {
    console.log('');
    console.log(`(modo seco) ${plano.conserta.length} jogo(s) seriam afetados. Nada foi gravado.`);
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
