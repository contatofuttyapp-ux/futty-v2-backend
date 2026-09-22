// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA DA ECONOMIA (18-set) — baratear a V6 sem trocar de motor.
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ A VARIANTE 3 É A PRODUÇÃO desde 22-set (decisão do dono, 7 folhas).    │
// │ US$0,049 reais contra US$0,112 da V6, 0/7 cabeças cortadas, 0/7        │
// │ uniformes errados. A receita dela vive agora em                        │
// │ utils/geracaoFigurinha.js e é de lá que esta bancada a chama — correr  │
// │ isto outra vez compara sempre contra o que está mesmo no ar.          │
// └────────────────────────────────────────────────────────────────────────┘
//
// Onde estamos: a V6 (gpt-image-1.5/edit + P2 + entrada quadrada + fidelidade
// alta) é a única receita aprovada, e custa US$0,112. Duas bancadas já tentaram
// baratear trocando de motor (todos reprovados) e pintando o 2.5 por prompt
// (não pegou). Esta tenta dois caminhos diferentes:
//
//   A) PAGAR MENOS PELA MESMA CHAMADA. A fal cobra os tokens da imagem de
//      ENTRADA, e em fidelidade alta uma imagem 1024×1024 são 3.050 tokens
//      (US$0,024). Mandar o kit — que é um desenho chapado, sem detalhe fino —
//      a 512×512 deve cortar boa parte disso. A foto a 768 corta mais. A
//      pergunta: até onde se pode encolher sem o uniforme sair errado?
//
//   B) DUAS PASSADAS. A passada 1 já está paga e feita: o 2.5 low (US$0,025)
//      dá a CARA, que o dono aprovou. A passada 2 só repinta: manda a imagem
//      pronta com fidelidade BAIXA (135 tokens em vez de 3.050) e pede pintura
//      sem mudar mais nada. Se funcionar, a figurinha sai por ~metade.
//
// VARIANTES
//   1  V6 exata, kit a 512x512
//   2  V6 exata, kit a 512x512 + foto a 768x768
//   3  duas passadas: 2.5 low (já pago) → gpt-image-1.5 low + fidelidade BAIXA
//   4  duas passadas: 2.5 low (já pago) → flux-2 klein 9b base
//   5  (cópia, não gera) V6 de referência, de saida-prompt/<foto>/6.png
//   6  (cópia, não gera) 2.5 low puro, de saida-modelos-2/<foto>/1.png
//
// A ENTRADA DA PASSADA 2 não é o 1.png tal e qual: esse ficheiro é a figurinha
// MONTADA (512x768, com moldura dourada e fundo escuro da casa). Mandá-lo
// assim faria o modelo repintar a moldura. Então: corta-se a moldura, passa-se
// pelo birefnet (US$0,002, registado) e compõe-se o jogador sobre o cinza
// #8a8a8a que o prompt promete, em 1024x1536.
//
// CORRER:
//   node scripts/_bench/testar-economia.js --so-um --teto 0.60   triagem (Gui)
//   node scripts/_bench/testar-economia.js --resto --teto 1.90   as outras 6
//   --so 1,3           só estas variantes
//   --foto <prefixo>   só a foto cujo nome começa assim
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
// Módulos de PRODUÇÃO — o que se mede é o que está no ar.
const { montarPrompt, promptRepintura } = require('../../prompts/figurinha');
const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
const { chamarFal, emDolares } = require('../../utils/falFila');
const { baixar, recortarFundo, achatamento, montarFigurinha, folhaDeContato, paraCsv, lerKit } = require('./comum');

const SAIDA = path.join(__dirname, 'saida-economia');
const DA_V6 = path.join(__dirname, 'saida-prompt');          // 6.png = V6
const DO_2_5 = path.join(__dirname, 'saida-modelos-2');      // 1.png = 2.5 low puro
const FOTOS = path.join(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const FOTO_TRIAGEM = 'Gui.jpeg';
const KIT_ID = 'dark-gold';

const V6_ENDPOINT = 'fal-ai/gpt-image-1.5/edit';
const FLUX_ENDPOINT = 'fal-ai/flux-2/klein/9b/base/edit';
// Os dois motores pedem o tamanho em formatos DIFERENTES, e trocá-los dá 422
// (custou três chamadas recusadas na primeira corrida desta bancada): o
// gpt-image-1.5 só aceita o enum em string ('1024x1536', como está na
// produção); o flux aceita o objeto {width,height}.
const TAMANHO_1_5 = '1024x1536';
const TAMANHO = { width: 1024, height: 1536 };
const CINZA = { r: 0x8a, g: 0x8a, b: 0x8a };

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

const CUSTO_BIREFNET = 0.002;
const CUSTO_PASSADA1 = 0.025; // o 2.5 low que já foi pago na bancada de modelos
const ESTIMATIVA = { 1: 0.095, 2: 0.085, 3: 0.055, 4: 0.075 };

// A conversão do header por endpoint vive em utils/falFila.js (módulo único):
// produção e bancadas convertem pelo mesmo sítio, senão medem coisas diferentes.

const P2 = montarPrompt(KIT_ID);

// O prompt da passada 2 vem do módulo de produção (prompts/figurinha.js):
// foi esta bancada que o escreveu, e quando a variante 3 virou produção ele
// mudou-se para lá. Aqui fica só a chamada — nada de cópia.
const PROMPT_REPINTAR = promptRepintura();

/** Sobe um buffer ao bucket público e devolve o URL. */
async function subir(caminho, buffer, tipo, temporarios) {
  const { error } = await supabase.storage.from('kits').upload(caminho, buffer, { contentType: tipo, upsert: true });
  if (error) throw new Error(`upload ${caminho}: ${error.message}`);
  temporarios.push(caminho);
  const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
  return `${pub.publicUrl}?v=${Date.now()}`;
}

/**
 * A entrada da passada 2, a partir da figurinha MONTADA da passada 1.
 * O 1.png tem a moldura dourada desenhada por cima e o fundo escuro da casa —
 * nenhum dos dois pode ir para o modelo. Corta-se a moldura (ela vive nos
 * primeiros ~11 px de 512), tira-se o fundo com o birefnet e assenta-se o
 * jogador no cinza que o prompt promete, com espaço acima da cabeça.
 */
async function entradaDaPassada2(caminho1png, temporarios, nome) {
  const buf = fs.readFileSync(caminho1png);
  const m = await sharp(buf).metadata();
  const corte = Math.round(m.width * 0.035); // ~18 px em 512: a moldura inteira
  const semMoldura = await sharp(buf)
    .extract({ left: corte, top: corte, width: m.width - corte * 2, height: m.height - corte * 2 })
    .png().toBuffer();

  const url = await subir(`tmp-economia/${nome}-p1.png`, semMoldura, 'image/png', temporarios);
  const rec = await recortarFundo(url);

  // O jogador ocupa 80% da altura e assenta a 94% da base — o mesmo
  // enquadramento que a montarFigurinha usa, para a passada 2 ver o que o app
  // veria.
  const jogador = await sharp(rec.trimado)
    .resize({ width: Math.round(TAMANHO.width * 0.82), height: Math.round(TAMANHO.height * 0.80), fit: 'inside' })
    .png().toBuffer();
  const mj = await sharp(jogador).metadata();
  const composto = await sharp({
    create: { width: TAMANHO.width, height: TAMANHO.height, channels: 3, background: CINZA },
  })
    .composite([{ input: jogador, left: Math.round((TAMANHO.width - mj.width) / 2), top: Math.round(TAMANHO.height * 0.94) - mj.height }])
    .png().toBuffer();

  return { composto, custoBirefnet: rec.custo.usd ?? CUSTO_BIREFNET, segundos: rec.segundos };
}

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  const teto = Number(arg('teto', '2.50'));
  const soVariantes = (arg('so', '') || '').split(',').map(Number).filter(Boolean);
  const quais = (n) => !soVariantes.length || soVariantes.includes(n);

  let fotos = fs.readdirSync(FOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  const soFoto = arg('foto', '');
  if (soFoto) fotos = fotos.filter((f) => f.toLowerCase().startsWith(soFoto.toLowerCase()));
  else if (tem('so-um')) fotos = fotos.filter((f) => f === FOTO_TRIAGEM);
  else if (tem('resto')) fotos = fotos.filter((f) => f !== FOTO_TRIAGEM);
  if (!fotos.length) { console.error('nenhuma foto para correr.'); process.exit(1); }

  const kit = lerKit(KIT_ID);
  const variantesActivas = [1, 2, 3, 4].filter(quais);
  const estimado = fotos.length * variantesActivas.reduce((s, n) => s + ESTIMATIVA[n], 0);
  console.log('\nBANCADA DA ECONOMIA · baratear a V6 sem trocar de motor');
  console.log(`Fotos: ${fotos.length} · variantes: ${variantesActivas.join(', ')} · gerações pagas: ${fotos.length * variantesActivas.length}`);
  console.log(`Estimativa: $${estimado.toFixed(2)} · tecto $${teto.toFixed(2)}`);
  if (estimado > teto) { console.error('\nRECUSADO: a estimativa passa o tecto.\n'); process.exit(1); }
  console.log('  1  V6 + kit 512                    gpt-image-1.5 low · fidelidade high · 2 imagens');
  console.log('  2  V6 + kit 512 + foto 768         gpt-image-1.5 low · fidelidade high · 2 imagens');
  console.log('  3  2 passadas · repintar (1.5)     gpt-image-1.5 low · fidelidade LOW  · 1 imagem');
  console.log('  4  2 passadas · repintar (flux)    flux-2 klein 9b base · sem strength no schema');
  console.log('');

  fs.mkdirSync(SAIDA, { recursive: true });
  const ficheiroCsv = path.join(SAIDA, 'custos.csv');
  const linhas = fs.existsSync(ficheiroCsv)
    ? fs.readFileSync(ficheiroCsv, 'utf8').trim().split('\n').map((l) => l.split(','))
    : [['foto', 'variante', 'receita', 'endpoint', 'parametros', 'custo_total_usd', 'detalhe_custo', 'segundos', 'dimensao', 'achatamento', 'cabeca_cortada', 'uniforme']];
  const temporarios = [];
  let gasto = 0;

  // O kit reduzido sobe UMA vez e serve todas as fotos e as variantes 1 e 2.
  let kitPequenoUrl = null;
  if (quais(1) || quais(2)) {
    const kitBuf = await baixar(kit.url);
    const kit512 = await sharp(kitBuf).resize(512, 512, { fit: 'inside', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    kitPequenoUrl = await subir('tmp-economia/kit-512.png', kit512, 'image/png', temporarios);
    const mk = await sharp(kitBuf).metadata();
    const mk2 = await sharp(kit512).metadata();
    console.log(`kit reduzido: ${mk.width}x${mk.height} (${(kitBuf.length / 1024).toFixed(0)} KB) → ${mk2.width}x${mk2.height} (${(kit512.length / 1024).toFixed(0)} KB)\n`);
  }

  const usados = new Set();
  for (const foto of fotos) {
    const cru = path.parse(foto).name.replace(/[^\w-]/g, '_').slice(0, 40);
    let nome = cru;
    for (let i = 2; usados.has(nome); i += 1) nome = `${cru}_${i}`;
    usados.add(nome);

    const pasta = path.join(SAIDA, nome);
    fs.mkdirSync(pasta, { recursive: true });
    console.log(`── ${nome} ${'─'.repeat(Math.max(0, 52 - nome.length))}`);

    // As duas entradas de foto: a de produção (1024) e a encolhida (768).
    let foto1024Url; let foto768Url;
    try {
      const quadrada = await preprocessarQuadrado(fs.readFileSync(path.join(FOTOS, foto)));
      fs.writeFileSync(path.join(pasta, 'entrada.jpg'), quadrada);
      if (quais(1)) foto1024Url = await subir(`tmp-economia/${nome}-1024.jpg`, quadrada, 'image/jpeg', temporarios);
      if (quais(2)) {
        const f768 = await sharp(quadrada).resize(768, 768, { kernel: sharp.kernel.lanczos3 }).jpeg({ quality: 90 }).toBuffer();
        foto768Url = await subir(`tmp-economia/${nome}-768.jpg`, f768, 'image/jpeg', temporarios);
      }
    } catch (e) {
      console.error(`   entrada falhou: ${e.message} — salto esta foto`);
      continue;
    }

    // A entrada das duas passadas: sai da figurinha do 2.5 já paga.
    let passada2Url = null; let custoPrep = 0;
    if (quais(3) || quais(4)) {
      const de1 = path.join(DO_2_5, nome, '1.png');
      if (!fs.existsSync(de1)) {
        console.log(`   3/4 sem a passada 1 (${path.relative(SAIDA, de1)}) — variantes de duas passadas saltadas nesta foto`);
      } else {
        try {
          const prep = await entradaDaPassada2(de1, temporarios, nome);
          fs.writeFileSync(path.join(pasta, 'entrada-passada2.png'), prep.composto);
          passada2Url = await subir(`tmp-economia/${nome}-p2.png`, prep.composto, 'image/png', temporarios);
          custoPrep = prep.custoBirefnet;
          gasto += custoPrep;
        } catch (e) {
          console.error(`   preparação da passada 2 falhou: ${e.message}`);
        }
      }
    }

    const receitas = [
      quais(1) && {
        n: 1, nome: 'V6 + kit 512', endpoint: V6_ENDPOINT,
        corpo: { prompt: P2, image_urls: [foto1024Url, kitPequenoUrl], quality: 'low', image_size: TAMANHO_1_5, input_fidelity: 'high', num_images: 1 },
        params: 'foto 1024 · kit 512 · fidelity high',
      },
      quais(2) && {
        n: 2, nome: 'V6 + kit 512 + foto 768', endpoint: V6_ENDPOINT,
        corpo: { prompt: P2, image_urls: [foto768Url, kitPequenoUrl], quality: 'low', image_size: TAMANHO_1_5, input_fidelity: 'high', num_images: 1 },
        params: 'foto 768 · kit 512 · fidelity high',
      },
      quais(3) && passada2Url && {
        n: 3, nome: '2 passadas · repintar (1.5)', endpoint: V6_ENDPOINT,
        corpo: { prompt: PROMPT_REPINTAR, image_urls: [passada2Url], quality: 'low', image_size: TAMANHO_1_5, input_fidelity: 'low', num_images: 1 },
        params: 'passada 2 · 1 imagem · fidelity LOW',
        somaPassada1: true,
      },
      quais(4) && passada2Url && {
        n: 4, nome: '2 passadas · repintar (flux)', endpoint: FLUX_ENDPOINT,
        // O schema do flux-2 klein NÃO tem strength nem denoise (conferido antes
        // de gastar): o que há é guidance_scale (omissão 5). Fica na omissão,
        // e o controlo de "muda pouco" tem de vir do prompt.
        corpo: { prompt: PROMPT_REPINTAR, image_urls: [passada2Url], image_size: TAMANHO, num_images: 1, output_format: 'png' },
        params: 'passada 2 · 1 imagem · sem strength no schema · guidance_scale omissão',
        somaPassada1: true,
      },
    ].filter(Boolean);

    for (const r of receitas) {
      if (gasto >= teto) { console.error(`   PARADO: já gastei $${gasto.toFixed(2)} (tecto $${teto.toFixed(2)})`); break; }
      try {
        const resp = await chamarFal(r.endpoint, r.corpo);
        const url = resp.dados?.images?.[0]?.url;
        if (!url) throw new Error('não devolveu imagem');
        const geradaBuf = await baixar(url);
        const dim = await sharp(geradaBuf).metadata().then((m) => `${m.width}x${m.height}`);

        const urlGerada = await subir(`tmp-economia/${nome}-v${r.n}.png`, geradaBuf, 'image/png', temporarios);
        const rec = await recortarFundo(urlGerada);
        const ach = await achatamento(rec.trimado);
        fs.writeFileSync(path.join(pasta, `${r.n}.png`), await montarFigurinha(rec.trimado));

        const conv = emDolares(r.endpoint, resp.custo);
        const custoChamada = (conv.usd ?? ESTIMATIVA[r.n]) + (rec.custo.usd ?? CUSTO_BIREFNET);
        // Nas duas passadas o que se paga por figurinha inclui a passada 1 (já
        // feita, mas dinheiro) e o birefnet da preparação.
        const custoTotal = custoChamada + (r.somaPassada1 ? CUSTO_PASSADA1 + custoPrep : 0);
        gasto += custoChamada;
        const detalhe = r.somaPassada1
          ? `passada2 ${conv.usd != null ? `$${conv.usd.toFixed(4)}` : 'estimativa'} + passada1 $${CUSTO_PASSADA1} + prep $${(custoPrep + CUSTO_BIREFNET).toFixed(3)}`
          : conv.nota;
        linhas.push([nome, r.n, r.nome, r.endpoint, r.params, custoTotal.toFixed(4), detalhe,
          (resp.segundos + rec.segundos).toFixed(1), dim, ach.razao === null ? '' : ach.razao.toFixed(2), ach.cortada ? 'S' : 'N', '']);
        console.log(`   ${r.n} ok  ${dim.padEnd(11)} achat ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : '        '} $${custoTotal.toFixed(4)} total${r.somaPassada1 ? ' (2 passadas)' : ''}  ${(resp.segundos + rec.segundos).toFixed(0)}s`);
      } catch (e) {
        console.error(`   ${r.n} FALHOU: ${e.message.slice(0, 140)}`);
        linhas.push([nome, r.n, r.nome, r.endpoint, r.params, '', 'FALHOU', '', '', '', '', '']);
      }
    }

    // As duas células de comparação, sem gastar.
    for (const [n, origem] of [[5, path.join(DA_V6, nome, '6.png')], [6, path.join(DO_2_5, nome, '1.png')]]) {
      if (fs.existsSync(origem)) fs.copyFileSync(origem, path.join(pasta, `${n}.png`));
      else console.log(`   ${n} (comparação) não existe em ${path.relative(SAIDA, origem)}`);
    }

    const naPasta = fs.readdirSync(pasta).filter((f) => /^[0-9]+\.png$/.test(f)).map((f) => Number(f.replace('.png', ''))).sort((a, b) => a - b);
    const ROTULO = {
      1: 'V6 + kit 512', 2: 'V6 + kit512 + foto768', 3: '2 passadas (1.5)',
      4: '2 passadas (flux)', 5: 'V6 REFERÊNCIA', 6: '2.5 low puro',
    };
    if (naPasta.length) {
      await folhaDeContato(
        naPasta.map((n) => ({ letra: `${n} · ${ROTULO[n] || n}`, png: fs.readFileSync(path.join(pasta, `${n}.png`)) })),
        path.join(pasta, 'folha-de-contato.png'),
      );
      console.log(`   folha: ${path.join(pasta, 'folha-de-contato.png')}`);
    }
  }

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});
  fs.writeFileSync(ficheiroCsv, paraCsv(linhas));

  const dados = linhas.slice(1).filter((l) => l[6] !== 'FALHOU');
  console.log(`\n${'='.repeat(92)}`);
  console.log('var  receita                          custo/figurinha   tempo    cortadas   n');
  for (const n of [1, 2, 3, 4]) {
    const ls = dados.filter((l) => Number(l[1]) === n);
    if (!ls.length) continue;
    const med = ls.reduce((s, l) => s + Number(l[5]), 0) / ls.length;
    const tmp = ls.reduce((s, l) => s + Number(l[7]), 0) / ls.length;
    const cort = ls.filter((l) => l[10] === 'S').length;
    console.log(`${String(n).padEnd(4)} ${ls[0][2].padEnd(32)} $${med.toFixed(4)}         ${tmp.toFixed(0)}s      ${cort}/${ls.length}       ${ls.length}`);
  }
  console.log(`\nV6 de referência: $0,1120 por figurinha`);
  console.log(`GASTO REAL DESTA CORRIDA: $${gasto.toFixed(2)}`);
  console.log(`Folhas: ${SAIDA}\\<foto>\\folha-de-contato.png`);
  console.log('Na folha: 5 é a V6 de hoje e 6 é o 2.5 puro (a passada 1) — é contra esses que se olha.');
  console.log('='.repeat(92));
})();
