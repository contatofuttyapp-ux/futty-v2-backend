// BANCADA — PROMPTS PARA QUALIDADE `low` ($0,009 no quadrado 1024×1024)
//
// ===========================================================================
// A TESE (o dono já tinha a prova na mão sem saber)
// ===========================================================================
// A figurinha de que ele mais gostou é ESTILIZADA, não fotorrealista: traço
// limpo, sombra em degraus, formas cheias. E veio de uma foto de entrada
// horrível — `sdasad.jpeg` tem nitidez 4 (variância do laplaciano) contra 638
// de uma foto normal, 150× menos nítida — e a semelhança ficou ótima.
//
// Logo: o modelo NÃO copia pixels, ele RE-DESENHA a partir da estrutura do
// rosto. Se re-desenha, o que o `low` tira é acabamento fino, não parecença.
// E se o estilo alvo já é de baixa frequência (pouco detalhe fino POR DESENHO),
// o `low` não tem onde parecer quebrado.
//
// ===========================================================================
// OS DOIS PARÂMETROS QUE A PRODUÇÃO NÃO USA (schema oficial do fal)
// ===========================================================================
// 1) image_size: 'auto' (omissão) | '1024x1024' | '1536x1024' | '1024x1536'
//    Produção não define → fica 'auto' → sai retrato → $0,051 em medium.
//    Pedir '1024x1024' explicitamente é o que destrava os $0,009 no low.
//
// 2) background: 'auto' (omissão) | 'transparent' | 'opaque'
//    O PRÓPRIO MODELO sabe devolver fundo transparente. Se funcionar:
//      · dispensa o birefnet (−$0,002 e um passo a menos)
//      · e MATA A CAUSA RAIZ da cabeça achatada — não há mais recorte a
//        confundir cabelo preto com fundo preto, porque quem faz o alpha é
//        quem desenhou o cabelo.
//    É a hipótese mais valiosa desta bancada. Testada em L1T e L2T.
//
// ===========================================================================
// OS CANDIDATOS
// ===========================================================================
//   L1  / L1T   CROMO GRÁFICO   — aposta cheia: cel shading, contorno de tinta,
//                                 cabelo em massas, zero microtextura, peito
//                                 limpo (o monograma borra no low).
//   L2  / L2T   PINTURA SIMPLES — meio caminho: mantém a pintura semi-realista
//                                 que ele já aprovou, mas proíbe alta
//                                 frequência. Escudo como forma sólida simples.
//   L3          SÓ ENCURTADO    — controlo de isolamento: mesmas palavras de
//                                 estilo da produção, só cortado e reordenado.
//                                 Separa o ganho mecânico do ganho estético.
//   (o sufixo T = background transparente, sem birefnet)
//   M0          é o controlo medium de produção, montado no runner.
//
// Comuns a todos os low: quadrado 1:1 · prompt curto e por prioridade ·
// luz de contorno · a regra do "nunca cortar a cabeça" movida para CIMA.

// ---------------------------------------------------------------------------
// Blocos partilhados
// ---------------------------------------------------------------------------

const FACE = `FACE — HIGHEST PRIORITY:
Study Image 1 and preserve exactly: face shape and proportions, eye shape and
expression, nose, lips, skin tone, hair colour, beard/moustache style.
Image 1 may be blurry, noisy, dark or low resolution — read the underlying
facial STRUCTURE and redraw it cleanly and confidently. Do NOT reproduce noise,
grain or blur.
Never invent what is not visible in Image 1: no cap, no jewellery,
no tattoos unless clearly present.
SUNGLASSES RULE: if the person wears sunglasses or dark glasses in Image 1,
REMOVE them and paint natural, open eyes that match the face, age and
expression. NEVER keep sunglasses on the card. (Clear prescription glasses,
if obviously part of the person's look, may stay.)
The person must be instantly recognizable by a friend.`;

const CABECA = `HEAD — NEVER CROP:
Always draw the ENTIRE head with a complete, rounded crown and generous empty
space above it. If the head is cut by the edge of Image 1, reconstruct it
plausibly from the visible hair. A flat, truncated or edge-touching top of the
head is the single worst possible error in this task.`;

const ENQUADRAMENTO = `FRAMING — SQUARE:
- Square 1:1 composition
- Bust only: head down to mid-chest. No legs. No hands below chest level.
- Head large and horizontally centred; eyes at roughly 38% of the height
- At least 12% of the image height must be EMPTY space above the crown
- If in doubt, draw the figure SMALLER and leave MORE space above the head`;

// RONDA 2 (30-jul). A ronda 1 provou: o estilo do L2 funciona no low, mas TODAS
// as variantes quadradas cortaram a coroa (achatamento 0,66–0,96) enquanto o M0
// em retrato saiu limpo (0,02). A culpa é da GEOMETRIA, não da qualidade: num
// quadrado, "busto + cabeça grande" não deixa altura para o ar acima da cabeça.
// Dois consertos a testar:
const ENQ_RETRATO = `FRAMING — PORTRAIT:
- Portrait 2:3 composition (taller than wide)
- Bust only: head down to mid-chest. No legs. No hands below chest level.
- The figure must occupy only the BOTTOM 80% of the image
- The TOP 20% of the image must be COMPLETELY EMPTY — no hair, no head, nothing
- Head horizontally centred; eyes at roughly 40% of the height
- If in doubt, draw the figure SMALLER and leave MORE empty space above the head`;

const ENQ_QUADRADO_FOLGA = `FRAMING — SQUARE WITH FORCED HEADROOM:
- Square 1:1 composition
- The figure must occupy ONLY the BOTTOM 72% of the square
- The TOP 28% of the square must be COMPLETELY EMPTY — no hair, no head, nothing
  crosses into it. Measure this before you draw.
- Bust only: head down to mid-chest. No legs. No hands below chest level.
- Head horizontally centred and SMALLER than you would normally draw it
- The crown of the head must never touch or approach the top edge`;

const LUZ = `LIGHTING:
- Strong rim/edge light along the top of the head, the shoulders and the arms,
  clearly separating the figure from whatever is behind it
- Main light from the front-upper-left, warm; cool fill on the shadow side
- High contrast, deep blacks, no washed-out greys`;

// Fundo cinza: para o caminho com birefnet. Contraste contra cabelo preto.
const FUNDO_CINZA = `BACKGROUND:
- Perfectly flat, uniform MID-GREY #8a8a8a. Nothing else.
- This background is removed automatically afterwards; it exists ONLY so the
  figure's silhouette — including dark hair — separates cleanly from it.
- No scenery, no stadium, no crowd, no grass, no gradient, no vignette, no props.`;

// Fundo transparente: o modelo faz o alpha. Não há recorte a seguir.
const FUNDO_TRANSPARENTE = `BACKGROUND — FULLY TRANSPARENT:
- The background must be completely EMPTY and transparent. No colour, no fill.
- Cut the figure out cleanly: crisp, deliberate silhouette all the way around,
  including every part of the hair and the top of the head.
- Do not draw a shadow on the ground, a halo, a glow or a border.
- No scenery, no stadium, no crowd, no grass, no props of any kind.`;

const NUNCA = `NEVER: photographic realism, anime, chibi, cartoon mascot, any text or
lettering, watermark, extra logos, more than one person, white or blank kit,
legs, cropped head.`;

// RONDA 3 (30-jul). A prova de produção mostrou braço em falta (Renato) e braço
// cortado na borda (Kim2). Guarda explícita:
const BRACOS = `ARMS — COMPLETE FIGURE:
- BOTH arms fully drawn and complete — shoulder, elbow, forearm and hand
- NEVER a missing, amputated, hidden or half-drawn limb
- The figure must NOT touch the LEFT, RIGHT or TOP edges of the image; keep
  clear margin on both sides (the bottom edge is the natural bust crop)
- If the pose does not fit, draw the figure SMALLER — never cut an arm`;

// Estilo do L2G: a MESMA pintura do L2, empurrada 10-15% para o gráfico.
// A tese: o low falha em microdetalhe realista; quanto mais gráfico o traço,
// mais os defeitos viram estilo. PROPORÇÕES DO ROSTO INTOCÁVEIS — sem caricatura.
const ESTILO_GRAFICO = `STYLE — BOLD GRAPHIC PAINTING (stylized rendering, faithful face):
- Same premium trading-card painting as before, pushed ~15% more GRAPHIC:
  flatter shadow planes (2-3 tones per surface), stronger clean outlines,
  simplified colour blocking, bolder shapes
- FACE PROPORTIONS EXACTLY FAITHFUL to Image 1 — do NOT exaggerate nose, chin,
  ears or any feature. NO caricature. Only the RENDERING is stylized, never
  the anatomy.
- HAIR as bold clean masses; SKIN smooth with clear light planes, no texture
- FABRIC in large simple folds, no weave
- Rich saturated colour, high contrast; must look deliberate on a phone screen
- NOT photographic, NOT anime, NOT cartoon mascot, NOT chibi`;

const CORPO = `BODY: slightly athletic — a little broader in the shoulders, defined arms.
Still unmistakably the same person. Not a bodybuilder.`;

const POSE = `POSE: pick ONE that matches the personality visible in Image 1 — arms
crossed, clenched fist, thumbs up, or pointing up. One pose only, never mixed.`;

// ---------------------------------------------------------------------------
// Ajustes à secção KIT vinda do catálogo de produção
// ---------------------------------------------------------------------------
const LINHA_BADGE_RE = /^- Badge: single Futty monogram[^\n]*\n/m;

/** L1: remove o escudo. O monograma de duas F borra no low; carimba-se depois. */
function kitSemEscudo(kitTxt) {
  if (!LINHA_BADGE_RE.test(kitTxt)) throw new Error('Não encontrei a linha do Badge na secção KIT — o catálogo mudou de forma.');
  return kitTxt.replace(LINHA_BADGE_RE, '- Chest: LEFT CLEAN — no badge, no logo, no lettering of any kind\n');
}

/** L2: escudo como forma sólida simples em vez de "duas F espelhadas".
 *  Idempotente: desde 30-jul a produção JÁ traz o escudo simplificado —
 *  nesse caso devolve o texto como está. */
function kitEscudoSimples(kitTxt, acento = 'the accent colour') {
  if (/SOLID emblem/i.test(kitTxt)) return kitTxt; // já simplificado (produção pós-L2P)
  if (!LINHA_BADGE_RE.test(kitTxt)) throw new Error('Não encontrei a linha do Badge na secção KIT — o catálogo mudou de forma.');
  return kitTxt.replace(LINHA_BADGE_RE,
    `- Badge: ONE small, simple, SOLID emblem in ${acento} on the upper-left chest.\n` +
    `  A bold compact shape — not fine lettering. No text, no thin lines.\n`);
}

const fundoDe = (f) => (f === 'transparente' ? FUNDO_TRANSPARENTE : FUNDO_CINZA);

// Ronda 3: no low os detalhes pequenos do kit somem (o friso da manga foi o
// primeiro — visto na prova de produção de 30-jul). Checklist explícito:
const kitChecklist = (acento) => `KIT CHECKLIST — before finishing, verify ALL FIVE elements are present:
1. base colour of the jersey exactly as Image 2
2. the large diagonal panel in ${acento}
3. V-neck collar with thin ${acento} piping
4. thin ${acento} trim at BOTH sleeve cuffs — never plain cuffs
5. the solid ${acento} emblem on the upper-left chest
A missing cuff trim or missing piping is a kit ERROR. Image 2 is ground truth.`;

// ---------------------------------------------------------------------------
// L1 — CROMO GRÁFICO
// ---------------------------------------------------------------------------
const L1 = (kitTxt, acento, fundo) => `You are illustrating a collectible soccer sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face likeness · 2nd complete head with space above it ·
3rd the kit from Image 2 · 4th style.

${FACE}

${CABECA}

STYLE — BOLD GRAPHIC STICKER ILLUSTRATION:
- Cel shading: 2 to 3 FLAT tone steps per surface, hard-edged transitions.
  No soft airbrush gradients anywhere.
- Clean, confident ink outline around the figure and the main internal forms
- Limited saturated palette, rich blacks
- HAIR AS SOLID BOLD MASSES with a crisp silhouette — never individual strands
- SKIN smooth and clean — no pores, no stubble speckle, no skin texture
- FABRIC as a few large folds — no weave, no threads, no micro-texture
- Must read clearly and look deliberate when seen small, on a phone

${LUZ}

${CORPO}

${POSE}

${kitSemEscudo(kitTxt)}

${ENQUADRAMENTO}

${fundoDe(fundo)}

${NUNCA}`;

// ---------------------------------------------------------------------------
// L2 — PINTURA SIMPLIFICADA
// ---------------------------------------------------------------------------
const L2 = (kitTxt, acento, fundo, enq = ENQUADRAMENTO) => `You are illustrating a premium soccer player sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face likeness · 2nd complete head with space above it ·
3rd the kit from Image 2 · 4th style.

${FACE}

${CABECA}

STYLE — SEMI-REALISTIC DIGITAL PAINTING, BROAD BRUSH:
- Premium Panini / trading-card painting, painterly but CLEAN
- Broad confident brushwork; large simple shapes; crisp silhouette
- HAIR painted as masses with a clear outline — never strand by strand
- SKIN smooth, sculpted with light and shadow — no pores, no fine texture
- FABRIC as a few bold folds — NO visible weave or thread texture
- Rich deep colour, high contrast; must hold up when seen small on a phone
- NOT photographic, NOT anime, NOT cartoon

${LUZ}

${CORPO}

${POSE}

${kitEscudoSimples(kitTxt, acento)}

${enq}

${fundoDe(fundo)}

${NUNCA}`;

// ---------------------------------------------------------------------------
// L2B — o L2 de produção + guarda de braços (ronda 3). Serve para decidir se a
// guarda entra em produção sem mudar o estilo.
// ---------------------------------------------------------------------------
const L2B = (kitTxt, acento, fundo, enq = ENQUADRAMENTO) => `You are illustrating a premium soccer player sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face likeness · 2nd complete head with space above it ·
3rd complete figure with both arms · 4th the kit from Image 2 · 5th style.

${FACE}

${CABECA}

${BRACOS}

STYLE — SEMI-REALISTIC DIGITAL PAINTING, BROAD BRUSH:
- Premium Panini / trading-card painting, painterly but CLEAN
- Broad confident brushwork; large simple shapes; crisp silhouette
- HAIR painted as masses with a clear outline — never strand by strand
- SKIN smooth, sculpted with light and shadow — no pores, no fine texture
- FABRIC as a few bold folds — NO visible weave or thread texture
- Rich deep colour, high contrast; must hold up when seen small on a phone
- NOT photographic, NOT anime, NOT cartoon

${LUZ}

${CORPO}

${POSE}

${kitEscudoSimples(kitTxt, acento)}

${kitChecklist(acento)}

${enq}

${fundoDe(fundo)}

${NUNCA}`;

// ---------------------------------------------------------------------------
// L2G — pintura 15% mais gráfica + guarda de braços (ronda 3).
// ---------------------------------------------------------------------------
const L2Gf = (kitTxt, acento, fundo, enq = ENQUADRAMENTO) => `You are illustrating a premium soccer player sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face likeness · 2nd complete head with space above it ·
3rd complete figure with both arms · 4th the kit from Image 2 · 5th style.

${FACE}

${CABECA}

${BRACOS}

${ESTILO_GRAFICO}

${LUZ}

${CORPO}

${POSE}

${kitEscudoSimples(kitTxt, acento)}

${kitChecklist(acento)}

${enq}

${fundoDe(fundo)}

${NUNCA}`;

// ---------------------------------------------------------------------------
// L3 — SÓ ENCURTADO (isola as correcções mecânicas, sem estilização nova)
// ---------------------------------------------------------------------------
const L3 = (kitTxt, acento, fundo) => `You are creating a professional illustrated soccer player sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face accuracy · 2nd complete head with space above it ·
3rd kit accuracy · 4th pose · 5th style.

${FACE}

${CABECA}

STYLE:
- Premium Panini sticker illustration style, FIFA Ultimate Team card quality
- Semi-realistic digital painting, clean brushwork
- Rich deep colour rendering
- NOT photographic, NOT anime, NOT cartoon

${CORPO}

${POSE}

${kitTxt}

${ENQUADRAMENTO}

${fundoDe(fundo)}

${NUNCA}`;

// ---------------------------------------------------------------------------
// Catálogo. `fundo:'transparente'` → o runner pede background:'transparent'
// ao fal e NÃO chama o birefnet.
// ---------------------------------------------------------------------------
const VARIANTES = {
  L1:  { nome: 'L1 cromo gráfico',      qualidade: 'low', tamanho: '1024x1024', fundo: 'cinza',        montar: L1 },
  L1T: { nome: 'L1 cromo · transp.',    qualidade: 'low', tamanho: '1024x1024', fundo: 'transparente', montar: L1 },
  L2:  { nome: 'L2 pintura simples',    qualidade: 'low', tamanho: '1024x1024', fundo: 'cinza',        montar: L2 },
  L2T: { nome: 'L2 pintura · transp.',  qualidade: 'low', tamanho: '1024x1024', fundo: 'transparente', montar: L2 },
  L3:  { nome: 'L3 só encurtado',       qualidade: 'low', tamanho: '1024x1024', fundo: 'cinza',        montar: L3 },

  // --- RONDA 2: o estilo do L2 com os dois consertos de enquadramento ---
  // L2P: retrato, $0,013. 4× mais barato que o medium, com a altura que a
  //      cabeça precisa. É a aposta.
  // L2Q: quadrado, $0,009 (o preço que o dono quer), mas com ordem explícita
  //      de deixar 28% do topo vazio. Se passar, é o mais barato possível.
  L2P: { nome: 'L2 retrato $0,013',     qualidade: 'low', tamanho: '1024x1536', fundo: 'cinza', enq: ENQ_RETRATO,        montar: L2 },
  L2Q: { nome: 'L2 quadrado c/ folga',  qualidade: 'low', tamanho: '1024x1024', fundo: 'cinza', enq: ENQ_QUADRADO_FOLGA, montar: L2 },

  // --- RONDA 3: guarda de braços e estilo mais gráfico ---
  L2PB: { nome: 'L2P + guarda braços',  qualidade: 'low', tamanho: '1024x1536', fundo: 'cinza', enq: ENQ_RETRATO, montar: L2B },
  // --- RONDA 4 (1-ago): TRANSPARENTE em retrato — mata o birefnet e o cabelo
  //     comido por construção. Comparar com os L2PB já no disco. ---
  L2PT: { nome: 'L2P transp s/ birefnet', qualidade: 'low', tamanho: '1024x1536', fundo: 'transparente', enq: ENQ_RETRATO, montar: L2B },
  L2G:  { nome: 'L2G 15% mais gráfico', qualidade: 'low', tamanho: '1024x1536', fundo: 'cinza', enq: ENQ_RETRATO, montar: L2Gf },
};

module.exports = { VARIANTES, kitSemEscudo, kitEscudoSimples, FUNDO_CINZA, FUNDO_TRANSPARENTE };
