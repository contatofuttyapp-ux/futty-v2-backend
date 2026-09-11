// Futty v2.0 — Gabinete: store JSON dos dados editáveis à mão pelo dono (Operação +
// Publicidade). Mesmo padrão dos campeonatos/denúncias (Storage privado, sem DDL).
// Vive no bucket privado "denuncias" (owner-only) sob `_gabinete/operacao.json` — zero
// PII, só dinheiro/infra/registos. Seed = os valores reais de PAINEL-E-CUSTOS.md
// (editáveis; NÃO são medições — são estimativas do dono a ajustar à mão).
//
// Gabinete 2.0 (11-set): custos_fixos e registros ganharam schema novo (campos
// explícitos da aba Dinheiro/Registros do painel de 5 abas). custos/registos
// (schema antigo) saem — a página velha de 16 secções que os lia foi substituída.
// cobertura/protecao_dados/toggles continuam a existir (a Gabinete.jsx só deixa
// de MOSTRAR essas secções atrás da flag MOSTRAR_AVANCADO — o dado não morre).
const { randomUUID } = require('crypto');
const { supabase } = require('./db');

const BUCKET = 'denuncias';
const CAMINHO = '_gabinete/operacao.json';

const SEED = {
  // Aba Dinheiro > Custos fixos. Valores reais de hoje (PAINEL-E-CUSTOS.md §1):
  // tudo em plano grátis, R$0/mês fixo — só a IA custa, e essa vive à parte
  // em "IA do mês" (gasto_ia_diario), não aqui.
  custos_fixos: [
    { id: 'supabase', nome: 'Supabase', valor: 0, moeda: 'BRL', periodicidade: 'mês', proxima_data: '', pago: true, nota: 'Plano Free — banco, login, fotos' },
    { id: 'render', nome: 'Render', valor: 0, moeda: 'BRL', periodicidade: 'mês', proxima_data: '', pago: true, nota: 'Plano Free — backend' },
    { id: 'vercel', nome: 'Vercel', valor: 0, moeda: 'BRL', periodicidade: 'mês', proxima_data: '', pago: true, nota: 'Plano Hobby — telas' },
    { id: 'github', nome: 'GitHub', valor: 0, moeda: 'BRL', periodicidade: 'mês', proxima_data: '', pago: true, nota: 'Free' },
    { id: 'sentry', nome: 'Sentry', valor: 0, moeda: 'BRL', periodicidade: 'mês', proxima_data: '', pago: true, nota: 'Free' },
  ],
  // Aba Registros & prazos. Seed real de PAINEL-E-CUSTOS.md §2 e §5/6.
  registros: [
    { id: 'inpi', nome: 'Marca FUTTY (INPI)', numero: '944951872', estado: 'aguardando publicação na RPI', data: '2026-08-25', nota: 'protocolada' },
    { id: 'paris', nome: 'Convenção de Paris — prazo de prioridade', numero: '-', estado: 'a depositar fora do Brasil', data: '2027-02-25', nota: 'janela de 6 meses da prioridade de 25/08/2026 (Portugal ~€127 ou EUIPO €850)' },
    { id: 'dominio-com', nome: 'Domínio futtyapp.com', numero: '-', estado: 'ativo', data: '2027-08-25', nota: '~US$11 · Porkbun' },
    { id: 'dominio-com-br', nome: 'Domínio futtyapp.com.br', numero: '-', estado: 'ativo', data: '2027-08-24', nota: 'R$40 · Registro.br' },
    { id: 'termos-privacidade', nome: 'Termos e Privacidade', numero: 'v1', estado: 'publicada (revisão jurídica pendente)', data: '2026-07-28', nota: 'ver /termos e /privacidade' },
  ],
  // Aba Segurança — checklist manual (os itens automáticos vêm do resumo, não daqui).
  seguranca_manual: {
    testes_permissao: { data: '', resultado: '' },
    npm_audit: { data: '', falhas: null },
    ultima_auditoria: { data: '', link: '' },
  },
  cobertura: {
    vende: ['🇵🇹 Portugal', '🇧🇷 Brasil', 'EUR', 'BRL'],
    bloqueado: ['🇺🇸 EUA', 'USD', '+ resto por ativar no IAP das lojas'],
  },
  campanhas: [],
  // toggle por página (default OFF). Chaves = as páginas onde há slot de publicidade.
  toggles: { inicio: false, sorteio: false, p: false },
  // Proteção de dados (LGPD/compliance) — editável à mão. Default tudo por tratar/publicar.
  protecao_dados: {
    dpas: ['Supabase', 'Railway', 'Vercel', 'fal.ai', 'Anthropic', 'Apple (IAP)', 'Google (IAP)'].map((nome) => ({ nome, estado: 'por tratar', data: '', link: '' })),
    politica_privacidade: { estado: 'publicada (revisão jurídica pendente)', data: '2026-07-28', url: '/privacidade' },
    termos_uso: { estado: 'publicada (revisão jurídica pendente)', data: '2026-07-28', url: '/termos' },
    canal_titular: { estado: 'ativo', destino: 'contatofuttyapp@gmail.com' },
  },
};

async function ler() {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(CAMINHO);
    if (!data) return { ...SEED };
    const txt = await data.text();
    return { ...SEED, ...JSON.parse(txt) };
  } catch {
    return { ...SEED };
  }
}

async function gravar(obj) {
  const limpo = {
    custos_fixos: Array.isArray(obj?.custos_fixos) ? obj.custos_fixos : SEED.custos_fixos,
    registros: Array.isArray(obj?.registros) ? obj.registros : SEED.registros,
    seguranca_manual: obj?.seguranca_manual && typeof obj.seguranca_manual === 'object' ? obj.seguranca_manual : SEED.seguranca_manual,
    cobertura: obj?.cobertura && typeof obj.cobertura === 'object' ? obj.cobertura : SEED.cobertura,
    campanhas: Array.isArray(obj?.campanhas) ? obj.campanhas : [],
    toggles: obj?.toggles && typeof obj.toggles === 'object' ? obj.toggles : SEED.toggles,
    protecao_dados: obj?.protecao_dados && typeof obj.protecao_dados === 'object' ? obj.protecao_dados : SEED.protecao_dados,
  };
  await supabase.storage.from(BUCKET).upload(CAMINHO, Buffer.from(JSON.stringify(limpo)), { contentType: 'application/json', upsert: true });
  return limpo;
}

/** Gera um id curto para uma nova linha de custo/registro (o form do painel não manda um). */
function novoId() {
  return randomUUID().slice(0, 8);
}

module.exports = { ler, gravar, SEED, novoId };
