// Futty v2.0 — A mensalidade do time: as contas puras (sem banco), para testar no Node.
//
// O app não mexe em dinheiro: é uma lista "pagou / não pagou" por mês. O mês de referência é o do RELÓGIO DO TIME (teams.fuso,
// padrão São Paulo) — a mesma lei da hora do jogo: o mês vira à meia-noite do campo, não à do celular de quem olha.
// Um mês é escrito "AAAA-MM" na API e guardado como o dia 1 ("AAAA-MM-01") no banco.
const { partesNoFuso, normalizarFuso } = require('./fuso');

const NOMES_DOS_MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// O admin corrige o mês atual e os 2 anteriores; os mais antigos ficam só para ler (ninguém reescreve o caixa de meio ano atrás).
const MESES_EDITAVEIS = 3;
// Até onde as setas voltam (além disso, o mês em que o time nasceu é o limite).
const MESES_DE_HISTORICO = 24;
const LIMITE_VALOR = 40;
const LIMITE_COMO_PAGAR = 300;
// O lembrete sai a partir das 10h do dia do vencimento, no relógio do time. Se nesse dia ninguém acordou o motor (nem o
// agendador), ainda sai nos 2 dias seguintes — nunca depois, para não cobrar uma semana atrasado quem esqueceu de abrir o app.
const HORA_DO_LEMBRETE = 10;
const DIAS_DE_ATRASO_DO_LEMBRETE = 2;

const RE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/;
const dois = (n) => String(n).padStart(2, '0');

/** O mês "AAAA-MM" em que o relógio do time está agora. */
function mesNoFuso(agora, fuso) {
  const p = partesNoFuso(agora, normalizarFuso(fuso));
  return `${p.ano}-${dois(p.mes)}`;
}

/** "AAAA-MM" → { ano, mes } (ou null). */
function partesDoMes(m) {
  const r = RE_MES.exec(String(m || ''));
  return r ? { ano: Number(r[1]), mes: Number(r[2]) } : null;
}

/** O mês `n` meses antes (n negativo = depois). */
function mesAntes(m, n = 1) {
  const p = partesDoMes(m);
  const total = p.ano * 12 + (p.mes - 1) - n;
  return `${Math.floor(total / 12)}-${dois((total % 12) + 1)}`;
}

/** "AAAA-MM" → "AAAA-MM-01" (como o banco guarda). */
const dataDoMes = (m) => `${m}-01`;
/** "AAAA-MM-DD" (do banco) → "AAAA-MM". */
const mesDaData = (d) => String(d || '').slice(0, 7);

function diasNoMes(m) {
  const p = partesDoMes(m);
  return new Date(Date.UTC(p.ano, p.mes, 0)).getUTCDate();
}

/** O dia em que vence a mensalidade naquele mês ("AAAA-MM-DD"), ou null sem dia. Dia 31 em mês de 30 vira o 30; em fevereiro, o 28/29. */
function vencimentoDoMes(m, dia) {
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) return null;
  return `${m}-${dois(Math.min(dia, diasNoMes(m)))}`;
}

/** O admin ainda corrige este mês? (o atual e os 2 anteriores; mês futuro, nunca) */
function mesEditavel(m, atual) {
  if (!partesDoMes(m)) return false;
  for (let i = 0; i < MESES_EDITAVEIS; i += 1) if (mesAntes(atual, i) === m) return true;
  return false;
}

/**
 * O mês pedido na URL, se for um mês que se pode ver: entre o primeiro (o mês em que o time nasceu, no máximo 24 para trás) e o atual.
 * Qualquer outra coisa (vazio, torto, futuro, antigo demais) vale o atual.
 */
function mesPedido(pedido, atual, primeiro) {
  if (!partesDoMes(pedido)) return atual;
  if (pedido > atual) return atual;
  return pedido < primeiro ? atual : pedido;
}

/** O mês mais antigo que as setas alcançam: o do nascimento do time, sem passar de 24 meses atrás. */
function primeiroMes(atual, criadoEm, fuso) {
  const limite = mesAntes(atual, MESES_DE_HISTORICO - 1);
  const nasceu = criadoEm ? mesNoFuso(criadoEm, fuso) : limite;
  return nasceu > limite ? (nasceu > atual ? atual : nasceu) : limite;
}

/** "outubro" — para o push ("Mensalidade de outubro do Missa de Quinta em aberto"). */
const nomeDoMes = (m) => NOMES_DOS_MESES[partesDoMes(m).mes - 1];

const textoOuNulo = (v) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
};

/**
 * O que chega do app para a configuração → o que vai para o banco. Só as chaves que vieram (o resto fica como está).
 * Devolve { mudancas } ou { erro } (frase para a tela).
 */
function configDoPedido(corpo) {
  const b = corpo && typeof corpo === 'object' ? corpo : {};
  const m = {};
  for (const k of ['ativa', 'lista_publica', 'lembrete']) {
    if (!(k in b)) continue;
    if (typeof b[k] !== 'boolean') return { erro: 'Use ligado ou desligado.' };
    m[k] = b[k];
  }
  if ('valor' in b) {
    const v = textoOuNulo(b.valor);
    if (v && v.length > LIMITE_VALOR) return { erro: `O valor tem no máximo ${LIMITE_VALOR} letras.` };
    m.valor = v;
  }
  if ('dia_vencimento' in b) {
    const d = b.dia_vencimento === null || b.dia_vencimento === '' ? null : Number(b.dia_vencimento);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 31)) return { erro: 'O vencimento é um dia de 1 a 31.' };
    m.dia_vencimento = d;
  }
  if ('como_pagar' in b) {
    // Aqui só se guarda o texto. Se ele vira um botão "Pagar" (só http/https) é decisão das telas, na hora de mostrar.
    const t = String(b.como_pagar ?? '').trim();
    if (t.length > LIMITE_COMO_PAGAR) return { erro: `"Como pagar" tem no máximo ${LIMITE_COMO_PAGAR} letras.` };
    m.como_pagar = t || null;
  }
  return { mudancas: m };
}

/**
 * O lembrete do vencimento sai agora para este time? Devolve o mês ("AAAA-MM") ou null. Precisa da mensalidade e do lembrete
 * ligados e de um dia de vencimento; sai do vencimento às 10h (relógio do time) até 2 dias depois.
 */
function mesDoLembrete({ agora, fuso, ativa, lembrete, dia_vencimento: dia }) {
  if (!ativa || !lembrete) return null;
  const f = normalizarFuso(fuso);
  const p = partesNoFuso(agora, f);
  const mes = `${p.ano}-${dois(p.mes)}`;
  const venc = vencimentoDoMes(mes, dia);
  if (!venc) return null;
  const diaVenc = Number(venc.slice(8));
  if (p.dia < diaVenc || p.dia > diaVenc + DIAS_DE_ATRASO_DO_LEMBRETE) return null;
  if (p.dia === diaVenc && p.hora < HORA_DO_LEMBRETE) return null;
  return mes;
}

module.exports = {
  MESES_EDITAVEIS, LIMITE_VALOR, LIMITE_COMO_PAGAR, HORA_DO_LEMBRETE, DIAS_DE_ATRASO_DO_LEMBRETE,
  mesNoFuso, mesAntes, dataDoMes, mesDaData, diasNoMes, vencimentoDoMes, mesEditavel, mesPedido, primeiroMes, nomeDoMes,
  configDoPedido, mesDoLembrete,
};
