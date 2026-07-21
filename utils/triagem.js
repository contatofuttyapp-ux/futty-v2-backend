// Triagem de denúncias (Tijolo 3, Fase B) — o cérebro da SPEC-DENUNCIAS §3.
// Motor: Fable (claude-fable-5) quando ANTHROPIC_API_KEY existe; senão fallback
// conservador por regras (o fluxo funciona e é provável sem chave). Camada
// substituível: quem chama nunca sabe qual motor decidiu.
//
// LEIS DURAS aplicadas SEMPRE no servidor (nunca se confia só no modelo):
//  - categoria "menor" → decisao "escalar" (nunca outra);
//  - "remover" só vale com confianca ≥ 0.90; abaixo disso degrada para "fila_humana"
//    (dúvida = humano, nunca auto-remoção por engano).
const LIMIAR_REMOVER = 0.90;
const DECISOES = ['remover', 'arquivar_improcedente', 'fila_humana', 'escalar'];

let _anthropic = null;
function cliente() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
    return _anthropic;
  } catch {
    return null;
  }
}

// O prompt real da SPEC §3 (Fable devolve só JSON).
function construirPrompt({ categoria, tipo, conteudo, contexto }) {
  return `És o moderador de triagem do Futty, uma app de futebol amador entre amigos.
Recebes UMA denúncia e decides o encaminhamento. És CONSERVADOR: na dúvida,
mandas para revisão humana — nunca removes por engano, nunca arquivas um caso
sério como improcedente.

DENÚNCIA
- categoria escolhida pelo denunciante: ${categoria}
- tipo de conteúdo: ${tipo}
- conteúdo: ${conteudo}
- contexto: ${contexto}

REGRAS
1. Se a categoria for "menor" (perigo a menor): decisao = "escalar" SEMPRE. Nunca outra.
2. Só "remover" se a infração for INEQUÍVOCA e grave (confianca alta).
3. Só "arquivar_improcedente" se for CLARAMENTE inócuo E categoria de baixo risco
   (spam). Nunca arquives assédio, ódio, nudez ou menor.
4. Qualquer ambiguidade, contexto pessoal, ou categoria sensível → "fila_humana".`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisao: { type: 'string', enum: DECISOES },
    confianca: { type: 'number' },
    justificativa: { type: 'string' },
  },
  required: ['decisao', 'confianca', 'justificativa'],
};

// Fallback conservador (sem LLM). Demonstra a política; a nuance fica para o Fable.
function triagemRegras({ categoria }) {
  if (categoria === 'menor') return { decisao: 'escalar', confianca: 1, justificativa: 'Regra dura: perigo a menor escala sempre.' };
  if (categoria === 'spam') return { decisao: 'arquivar_improcedente', confianca: 0.8, justificativa: 'Spam sem sinais de golpe — arquivado (sem LLM).' };
  return { decisao: 'fila_humana', confianca: 0.5, justificativa: 'Precisa de olho humano (sem LLM para decidir).' };
}

// Aplica as leis duras a qualquer veredicto (do modelo ou das regras).
function reforcarLeis(v, categoria) {
  if (categoria === 'menor') return { ...v, decisao: 'escalar' };
  if (v.decisao === 'remover' && (v.confianca || 0) < LIMIAR_REMOVER) {
    return { ...v, decisao: 'fila_humana', justificativa: `${v.justificativa} (confiança < ${LIMIAR_REMOVER} → humano)` };
  }
  if (!DECISOES.includes(v.decisao)) return { ...v, decisao: 'fila_humana' };
  return v;
}

/**
 * Tria uma denúncia. Devolve { decisao, confianca, justificativa, motor }.
 * "menor" nunca chega ao modelo (curto-circuito). Fable falha → regras.
 */
async function triar(entrada) {
  if (entrada.categoria === 'menor') {
    return { ...reforcarLeis({ decisao: 'escalar', confianca: 1, justificativa: 'Regra dura: perigo a menor escala sempre.' }, 'menor'), motor: 'lei' };
  }
  const client = cliente();
  if (!client) {
    return { ...reforcarLeis(triagemRegras(entrada), entrada.categoria), motor: 'regras' };
  }
  try {
    // Fable: thinking sempre on (omitir o parâmetro); JSON via output_config.format;
    // fallback server-side para Opus por defeito; tratar recusa.
    const resp = await client.beta.messages.create({
      model: 'claude-fable-5',
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' },
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      messages: [{ role: 'user', content: construirPrompt(entrada) }],
    });
    if (resp.stop_reason === 'refusal') {
      return { ...reforcarLeis(triagemRegras(entrada), entrada.categoria), motor: 'regras(recusa)' };
    }
    const bloco = (resp.content || []).find((b) => b.type === 'text');
    const v = JSON.parse(bloco.text);
    return { ...reforcarLeis(v, entrada.categoria), motor: 'fable' };
  } catch (e) {
    console.error('[triagem] Fable falhou, usa regras:', e.message);
    return { ...reforcarLeis(triagemRegras(entrada), entrada.categoria), motor: 'regras(erro)' };
  }
}

module.exports = { triar, LIMIAR_REMOVER, DECISOES };
