// ═══════════════════════════════════════════════════════════════════════════════
// PROVA DA RECEITA V6 (SPEC-FIGURINHA-3 §4, 22-set).
//
// A Brilhante é paga, por isso leva a MELHOR receita — a V6 que o dono avaliou
// em 4,1/5 na bancada cega de 17-set, e não as duas passadas (US$0,05) que
// serviam a figurinha grátis. Esta prova responde a uma pergunta só: a V6
// continua a funcionar exactamente como em 17-set?
//
//   mesmo motor      fal-ai/gpt-image-1.5/edit, quality low
//   mesma entrada    corte QUADRADO 1024×1024 (utils/entradaFigurinha.js)
//   mesma fidelidade input_fidelity: high
//   mesmo prompt     prompts/figurinha.js (P2)
//   mesmo custo      ~US$0,112 + US$0,002 do birefnet
//
// Chama `gerarFigurinha` DIRETO, sem passar pela rota: o portão do direito
// (§5) é outra coisa e tem os seus próprios testes. Usa a foto do modelo
// FICTÍCIO da conta demo — nunca uma pessoa real (regra de 17-set).
//
//   node scripts/_bench/prova-v6.js
//   --receita duas-passadas   compara com a receita alternativa (US$0,05)
//
// Custo: uma geração real (~US$0,11).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
const { gerarFigurinha, RECEITA, V6_ENDPOINT, FIDELIDADE_V6, QUALIDADE, TAMANHO_1_5 } = require('../../utils/geracaoFigurinha');
const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
const { achatamento, lerKit, montarFigurinha } = require('./comum');

const FOTO = path.join(__dirname, 'estado-demo', 'foto-silhueta-original.jpg');
const SAIDA = path.join(__dirname, 'saida-producao');
const KIT_ID = 'dark-gold';
const arg = (n, o) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : o; };

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }
  const receita = arg('receita', RECEITA);
  const kit = lerKit(KIT_ID);
  const temporarios = [];

  const subir = async (nome, buf, tipo) => {
    const caminho = `tmp-prova-v6/${Date.now()}-${nome}`;
    const { error } = await supabase.storage.from('kits').upload(caminho, buf, { contentType: tipo, upsert: true });
    if (error) throw new Error(`upload ${caminho}: ${error.message}`);
    temporarios.push(caminho);
    const { data } = supabase.storage.from('kits').getPublicUrl(caminho);
    return `${data.publicUrl}?v=${Date.now()}`;
  };

  console.log(`\nPROVA DA V6 · receita "${receita}"`);
  console.log(`  motor       ${V6_ENDPOINT}`);
  console.log(`  qualidade   ${QUALIDADE} · fidelidade ${FIDELIDADE_V6} · saída ${TAMANHO_1_5}`);
  console.log(`  entrada     corte quadrado 1024×1024 (a mesma de 17-set)`);
  console.log(`  foto        modelo fictício da conta demo (nunca uma pessoa real)\n`);

  const quadrada = await preprocessarQuadrado(fs.readFileSync(FOTO));
  const m = await sharp(quadrada).metadata();
  console.log(`entrada pronta: ${m.width}×${m.height}, ${Math.round(quadrada.length / 1024)} KB`);
  const fotoUrl = await subir('entrada.jpg', quadrada, 'image/jpeg');

  const t0 = Date.now();
  const r = await gerarFigurinha({
    fotoUrl, kitUrl: kit.url, kitId: KIT_ID, receita, etiqueta: 'prova-v6',
    publicar: (nome, buf, tipo) => subir(nome, buf, tipo),
  });
  const segundos = Math.round((Date.now() - t0) / 1000);

  const trimado = await sharp(r.recorteBuffer).trim({ threshold: 10 }).png().toBuffer();
  const ach = await achatamento(trimado);
  fs.mkdirSync(SAIDA, { recursive: true });
  const destino = path.join(SAIDA, `prova-${receita}-${new Date().toISOString().slice(0, 10)}-${KIT_ID}.png`);
  fs.writeFileSync(destino, await montarFigurinha(trimado));

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});

  console.log(`\n${'='.repeat(74)}`);
  console.log(`receita        ${r.receita}`);
  console.log(`custo REAL     US$${r.custo.usd.toFixed(4)}  (${r.custo.chamadas} chamadas, ${r.custo.semHeader} sem header)`);
  for (const [nome, p] of Object.entries(r.custo.parcelas)) {
    console.log(`  ${nome.padEnd(14)} ${p.usd == null ? '—' : `US$${p.usd.toFixed(4)}`}  ${p.nota}`);
  }
  console.log(`tempo          ${segundos}s  (${JSON.stringify(r.tempos)})`);
  console.log(`achatamento    ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? '  CABEÇA CORTADA' : '  (cabeça inteira)'}`);
  console.log(`figurinha      ${destino}`);
  console.log(`referência     17-set: US$0,112 · 22s · achatamento 0,02`);
  console.log('='.repeat(74));
})();
