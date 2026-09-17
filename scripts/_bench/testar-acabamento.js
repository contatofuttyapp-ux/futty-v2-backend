// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA DO ACABAMENTO (17-set) — a cara do 2.5 com o acabamento da V6.
//
// De onde vem: na bancada de modelos (commit 8628fd3) o dono viu as 7 folhas e
// disse que a CARA dos candidatos 1 e 2 (openai/gpt-image-2.5/flare/edit) está
// boa, mas o ACABAMENTO que ele quer é o da célula 8 — a V6, que é pintura
// semi-realista de figurinha. O 2.5 devolve algo mais perto de um retoque de
// foto: pele fotográfica, luz de celular, textura de JPEG. A pergunta aqui é
// uma só: dá para empurrar o 2.5 para a pintura, sem perder a cara?
//
// Se der, a conta muda: o 2.5 low custa US$0,025 contra os US$0,112 da V6 —
// 4,5× mais barato na mesma figurinha.
//
// VARIANTES (endpoint único: openai/gpt-image-2.5/flare/edit, 1024x1536):
//   1  low    + RENDERING reescrito para forçar pintura
//   2  medium + o mesmo RENDERING
//   3  low    + o mesmo RENDERING + uma TERCEIRA imagem de referência de
//              acabamento (uma figurinha V6 já pronta)
//   4  (não gera) o 2.5 low PURO, copiado de saida-modelos-2/<foto>/1.png
//   5  (não gera) a V6 de hoje, copiada de saida-modelos-2/<foto>/8.png
//
// A TERCEIRA IMAGEM É DO MODELO FICTÍCIO da conta demo, nunca de uma pessoa
// real da bancada: uma figurinha de gente real na entrada contaminaria a cara
// do retrato — que é justamente o que não se quer mexer. E o prompt diz, com
// todas as letras, que de Image 3 só se tira o acabamento.
//
// O resto é igual ao que está em produção e às outras bancadas: mesmas fotos,
// mesma entrada quadrada (utils/entradaFigurinha.js), mesmo kit dark-gold,
// mesmo prompt base (prompts/figurinha.js), mesmo birefnet, mesma leitura de
// custo real (utils/falFila.js + a tabela de conversão por endpoint).
//
// CORRER (a fal só resolve na máquina do Pedro):
//   node scripts/_bench/testar-acabamento.js --so-um     triagem: só o Gui
//   node scripts/_bench/testar-acabamento.js --resto     as outras 6 fotos
//   --teto 1.50        aborta antes de passar deste gasto
//   --so 1,3           só estas variantes
//   --foto <prefixo>   só a foto cujo nome começa assim
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
// Módulos de PRODUÇÃO — o que se mede é o que está no ar.
const { montarPrompt } = require('../../prompts/figurinha');
const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
const { chamarFal } = require('../../utils/falFila');
const { baixar, recortarFundo, achatamento, montarFigurinha, folhaDeContato, paraCsv, lerKit } = require('./comum');

const SAIDA = path.join(__dirname, 'saida-acabamento');
const DA_BANCADA_MODELOS = path.join(__dirname, 'saida-modelos-2'); // 2.5 puro (1.png) e V6 (8.png)
const FOTOS = path.join(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const REF_ACABAMENTO = path.join(__dirname, 'saida-producao', 'prova-real-2026-09-17-dark-gold.png');
const ENDPOINT = 'openai/gpt-image-2.5/flare/edit';
const FOTO_TRIAGEM = 'Gui.jpeg';
const KIT_ID = 'dark-gold';
const TAMANHO = { width: 1024, height: 1536 };

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

// O gpt-image-2.5 é cobrado por TOKENS e o header x-fal-billable-units já vem
// em dólares (ao contrário dos modelos de preço fixo, onde vem a contagem de
// unidades — ver PRECO_UNIDADE em testar-modelos.js). Aqui não há conversão a
// fazer: o que o header diz é o que se paga. Medido na bancada de modelos:
// low US$0,0229 e medium US$0,0285, mais US$0,002 do birefnet.
const ESTIMATIVA = { 1: 0.027, 2: 0.033, 3: 0.035 };
const CUSTO_BIREFNET = 0.002;

// ── os prompts ────────────────────────────────────────────────────────────────

const P2 = montarPrompt(KIT_ID);

// A regra dos óculos, reforçada. Na V6 três células do Gui saíram com lentes
// escuras na cara; no 2.5 elas viraram óculos de grau, que também não é o que
// se pede. Esta versão não deixa espaço: tira tudo e pinta os olhos.
const OCULOS_FORTE = 'SUNGLASSES: if Image 1 shows sunglasses, remove them completely — no glasses of any kind — and paint natural open eyes that fit this face.';
const trocarOculos = (p) => p.replace(
  /SUNGLASSES: if Image 1 shows sunglasses[^]*?never keep dark lenses\./,
  OCULOS_FORTE,
);

/**
 * O parágrafo que faz a diferença desta bancada. O RENDERING do P2 descreve o
 * resultado ("polished digital illustration"), e o 2.5 leu isso como "melhora a
 * foto". Este diz o que NÃO fazer — não é retoque — e nomeia o que estraga:
 * grão fotográfico, luz de celular, textura de JPEG.
 * O bloco FACE FIRST fica INTACTO de propósito: é dele que vem a cara que o
 * dono aprovou, e mexer nos dois ao mesmo tempo não deixaria saber qual mudou.
 */
const RENDERING_PINTURA = 'RENDERING — this is NOT a photo retouch: repaint the whole image as a polished '
  + 'semi-realistic digital painting in the style of a premium collectible football sticker card. Smooth '
  + 'painterly skin with soft clean brushwork, simplified but faithful features, gentle studio rim light, '
  + 'saturated yet natural colours, crisp clean edges on the kit. No photographic grain, no phone-camera '
  + 'lighting, no JPEG texture.';

function comRendering(p) {
  const ini = p.indexOf('RENDERING:');
  const fim = p.indexOf('\n\nPOSE:');
  if (ini < 0 || fim < 0) throw new Error('não achei o bloco RENDERING no P2 — aborta antes de gastar');
  return p.slice(0, ini) + RENDERING_PINTURA + p.slice(fim);
}

// A instrução da terceira imagem. É curta e repetitiva de propósito: o risco
// aqui é o modelo copiar a cara da referência, e vale mais dizer três vezes
// "só o acabamento" do que descobrir na figurinha que ele copiou o queixo.
const NOTA_IMAGE3 = '\n\nImage 3 shows ONLY the rendering style to match — painting finish, lighting, edge '
  + 'quality. Take nothing else from Image 3: not the face, hair, body or pose.';

const PROMPT_PINTURA = comRendering(trocarOculos(P2));
const PROMPT_PINTURA_REF = PROMPT_PINTURA + NOTA_IMAGE3;

const VARIANTES = [
  { n: 1, nome: 'low + RENDERING pintura', quality: 'low', prompt: PROMPT_PINTURA, refAcabamento: false },
  { n: 2, nome: 'medium + RENDERING pintura', quality: 'medium', prompt: PROMPT_PINTURA, refAcabamento: false },
  { n: 3, nome: 'low + pintura + Image 3 (ref.)', quality: 'low', prompt: PROMPT_PINTURA_REF, refAcabamento: true },
];

// As duas células que NÃO se geram: vêm da bancada de modelos, de graça.
const COPIAS = [
  { n: 4, nome: '2.5 low PURO (sem o RENDERING novo)', de: '1.png' },
  { n: 5, nome: 'V6 HOJE (produção)', de: '8.png' },
];

const rotuloCurto = {
  1: 'low + pintura', 2: 'medium + pintura', 3: 'low + pintura + ref',
  4: '2.5 low puro', 5: 'V6 HOJE (produção)',
};

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  const teto = Number(arg('teto', '1.50'));
  const soVariantes = (arg('so', '') || '').split(',').map(Number).filter(Boolean);
  const variantes = VARIANTES.filter((v) => !soVariantes.length || soVariantes.includes(v.n));

  let fotos = fs.readdirSync(FOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  const soFoto = arg('foto', '');
  if (soFoto) fotos = fotos.filter((f) => f.toLowerCase().startsWith(soFoto.toLowerCase()));
  else if (tem('so-um')) fotos = fotos.filter((f) => f === FOTO_TRIAGEM);
  else if (tem('resto')) fotos = fotos.filter((f) => f !== FOTO_TRIAGEM);
  if (!fotos.length) { console.error('nenhuma foto para correr.'); process.exit(1); }

  if (variantes.some((v) => v.refAcabamento) && !fs.existsSync(REF_ACABAMENTO)) {
    console.error(`A referência de acabamento não existe: ${REF_ACABAMENTO}`);
    console.error('É a figurinha V6 do modelo fictício da conta demo (prova-figurinha-real.js). Sem ela a variante 3 não corre.');
    process.exit(1);
  }

  const kit = lerKit(KIT_ID);
  const estimado = fotos.length * variantes.reduce((s, v) => s + (ESTIMATIVA[v.n] || 0.035) + CUSTO_BIREFNET, 0);
  console.log(`\nBANCADA DO ACABAMENTO · ${ENDPOINT} · ${TAMANHO.width}x${TAMANHO.height} · kit ${KIT_ID}`);
  console.log(`Fotos: ${fotos.length} · variantes: ${variantes.map((v) => v.n).join(', ')} · gerações: ${fotos.length * variantes.length}`);
  console.log(`Estimativa: $${estimado.toFixed(2)} · tecto $${teto.toFixed(2)}`);
  if (estimado > teto) { console.error('\nRECUSADO: a estimativa passa o tecto.\n'); process.exit(1); }
  for (const v of variantes) console.log(`  ${v.n}  ${v.nome.padEnd(32)} quality ${v.quality.padEnd(6)} · ${v.refAcabamento ? '3 imagens (foto, kit, ref)' : '2 imagens (foto, kit)'} · prompt ${v.prompt.length}ch`);
  console.log('');

  fs.mkdirSync(SAIDA, { recursive: true });
  const ficheiroCsv = path.join(SAIDA, 'custos.csv');
  const linhas = fs.existsSync(ficheiroCsv)
    ? fs.readFileSync(ficheiroCsv, 'utf8').trim().split('\n').map((l) => l.split(','))
    : [['foto', 'variante', 'quality', 'imagens_entrada', 'prompt_chars', 'custo_usd', 'unidades_no_header', 'fonte_custo', 'segundos', 'dimensao', 'achatamento', 'cabeca_cortada', 'uniforme']];
  const temporarios = [];
  let gasto = 0;

  // A referência de acabamento sobe UMA vez e serve todas as fotos.
  let refUrl = null;
  if (variantes.some((v) => v.refAcabamento)) {
    const caminho = 'tmp-acabamento/referencia-v6.png';
    const { error } = await supabase.storage.from('kits').upload(caminho, fs.readFileSync(REF_ACABAMENTO), { contentType: 'image/png', upsert: true });
    if (error) { console.error(`upload da referência falhou: ${error.message}`); process.exit(1); }
    temporarios.push(caminho);
    const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
    refUrl = `${pub.publicUrl}?v=${Date.now()}`;
    console.log(`referência de acabamento pronta (modelo fictício da conta demo): ${path.basename(REF_ACABAMENTO)}\n`);
  }

  const usados = new Set();
  for (const foto of fotos) {
    // Sufixo por colisão: dois nomes de foto podem dar a mesma pasta depois do
    // corte a 40 caracteres, e a segunda apagava a primeira (já custou gerações
    // pagas em duas bancadas antes desta).
    const cru = path.parse(foto).name.replace(/[^\w-]/g, '_').slice(0, 40);
    let nome = cru;
    for (let i = 2; usados.has(nome); i += 1) nome = `${cru}_${i}`;
    usados.add(nome);

    const pasta = path.join(SAIDA, nome);
    fs.mkdirSync(pasta, { recursive: true });
    console.log(`── ${nome} ${'─'.repeat(Math.max(0, 52 - nome.length))}`);

    let fotoUrl;
    try {
      const quadrada = await preprocessarQuadrado(fs.readFileSync(path.join(FOTOS, foto)));
      const caminho = `tmp-acabamento/${nome}.jpg`;
      const { error } = await supabase.storage.from('kits').upload(caminho, quadrada, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error(`upload: ${error.message}`);
      temporarios.push(caminho);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
      fotoUrl = `${pub.publicUrl}?v=${Date.now()}`;
      fs.writeFileSync(path.join(pasta, 'entrada.jpg'), quadrada);
    } catch (e) {
      console.error(`   entrada falhou: ${e.message} — salto esta foto`);
      continue;
    }

    for (const v of variantes) {
      if (gasto >= teto) { console.error(`   PARADO: já gastei $${gasto.toFixed(2)} (tecto $${teto.toFixed(2)})`); break; }
      const imagens = v.refAcabamento ? [fotoUrl, kit.url, refUrl] : [fotoUrl, kit.url];
      try {
        const r = await chamarFal(ENDPOINT, {
          prompt: v.prompt,
          image_urls: imagens,
          quality: v.quality,
          image_size: TAMANHO,
          num_images: 1,
          output_format: 'png',
        });
        const url = r.dados?.images?.[0]?.url;
        if (!url) throw new Error('não devolveu imagem');
        const geradaBuf = await baixar(url);
        const dim = await sharp(geradaBuf).metadata().then((m) => `${m.width}x${m.height}`);

        // O birefnet precisa de um URL público; a imagem da fal expira.
        const tmpGerada = `tmp-acabamento/${nome}-${v.n}.png`;
        const subida = await supabase.storage.from('kits').upload(tmpGerada, geradaBuf, { contentType: 'image/png', upsert: true });
        if (subida.error) throw new Error(`upload da gerada: ${subida.error.message}`);
        temporarios.push(tmpGerada);
        const { data: pubG } = supabase.storage.from('kits').getPublicUrl(tmpGerada);
        const rec = await recortarFundo(`${pubG.publicUrl}?v=${Date.now()}`);

        const ach = await achatamento(rec.trimado);
        fs.writeFileSync(path.join(pasta, `${v.n}.png`), await montarFigurinha(rec.trimado));

        // No 2.5 o header já vem em dólares — nada a converter.
        const custo = (r.custo.usd ?? ESTIMATIVA[v.n] ?? 0) + (rec.custo.usd ?? CUSTO_BIREFNET);
        gasto += custo;
        const fonte = r.custo.usd != null ? 'header em dólares' : 'estimativa (sem header)';
        linhas.push([nome, v.n, v.quality, imagens.length, v.prompt.length, custo.toFixed(4), r.custo.usd ?? '', fonte,
          (r.segundos + rec.segundos).toFixed(1), dim, ach.razao === null ? '' : ach.razao.toFixed(2), ach.cortada ? 'S' : 'N', '']);
        console.log(`   ${v.n} ok  ${dim.padEnd(11)} achat ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : '        '} $${custo.toFixed(4)} (${fonte})  ${(r.segundos + rec.segundos).toFixed(0)}s`);
      } catch (e) {
        console.error(`   ${v.n} FALHOU: ${e.message}`);
        linhas.push([nome, v.n, v.quality, imagens.length, v.prompt.length, '', '', 'FALHOU', '', '', '', '', '']);
      }
    }

    // As duas células de comparação vêm da bancada de modelos, sem gastar.
    for (const c of COPIAS) {
      const origem = path.join(DA_BANCADA_MODELOS, nome, c.de);
      if (fs.existsSync(origem)) fs.copyFileSync(origem, path.join(pasta, `${c.n}.png`));
      else console.log(`   ${c.n} (${c.nome}) não existe em saida-modelos-2/${nome}/${c.de} — folha sai sem esta célula`);
    }

    const naPasta = fs.readdirSync(pasta).filter((f) => /^[0-9]+\.png$/.test(f)).map((f) => Number(f.replace('.png', ''))).sort((a, b) => a - b);
    if (naPasta.length) {
      await folhaDeContato(
        naPasta.map((n) => ({ letra: `${n} · ${rotuloCurto[n] || n}`, png: fs.readFileSync(path.join(pasta, `${n}.png`)) })),
        path.join(pasta, 'folha-de-contato.png'),
      );
      console.log(`   folha: ${path.join(pasta, 'folha-de-contato.png')}`);
    }
  }

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});
  fs.writeFileSync(ficheiroCsv, paraCsv(linhas));

  // ── resumo ──
  const dados = linhas.slice(1).filter((l) => l[7] !== 'FALHOU');
  console.log(`\n${'='.repeat(86)}`);
  console.log('var  receita                          custo médio   tempo    cortadas   gerações');
  for (const v of VARIANTES) {
    const ls = dados.filter((l) => Number(l[1]) === v.n);
    if (!ls.length) continue;
    const med = ls.reduce((s, l) => s + Number(l[5]), 0) / ls.length;
    const tmp = ls.reduce((s, l) => s + Number(l[8]), 0) / ls.length;
    const cort = ls.filter((l) => l[11] === 'S').length;
    console.log(`${String(v.n).padEnd(4)} ${v.nome.padEnd(32)} $${med.toFixed(4)}      ${tmp.toFixed(0)}s      ${cort}/${ls.length}        ${ls.length}`);
  }
  console.log(`\nGASTO REAL DESTA CORRIDA: $${gasto.toFixed(2)} · total no CSV: $${dados.reduce((s, l) => s + Number(l[5] || 0), 0).toFixed(2)}`);
  console.log(`Folhas: ${SAIDA}\\<foto>\\folha-de-contato.png`);
  console.log('Na folha: 4 é o 2.5 low SEM o RENDERING novo e 5 é a V6 de hoje — é contra esses dois que se olha.');
  console.log('='.repeat(86));
})();
