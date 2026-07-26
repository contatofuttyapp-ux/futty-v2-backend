// Futty v2.0 — Gabinete: store JSON dos dados editáveis à mão pelo dono (Operação +
// Publicidade). Mesmo padrão dos campeonatos/denúncias (Storage privado, sem DDL).
// Vive no bucket privado "denuncias" (owner-only) sob `_gabinete/operacao.json` — zero
// PII, só dinheiro/infra/registos. Seed = os valores documentados na SPEC-GABINETE
// (editáveis; NÃO são medições — são estimativas do dono a ajustar à mão).
const { supabase } = require('./db');

const BUCKET = 'denuncias';
const CAMINHO = '_gabinete/operacao.json';

const SEED = {
  custos: [
    { nome: 'Railway', desc: 'servidor backend', valor: 5, ciclo: 'mês', renova: '', estado: 'ativo' },
    { nome: 'Supabase', desc: 'BD · auth · storage', valor: 0, ciclo: 'mês', renova: '', estado: 'free' },
    { nome: 'Vercel', desc: 'frontend', valor: 0, ciclo: 'mês', renova: '', estado: 'free' },
    { nome: 'fal.ai', desc: 'avatares IA', valor: 12, ciclo: 'uso', renova: 'contínuo', estado: 'uso' },
    { nome: 'Anthropic API', desc: 'triagem de denúncias', valor: 4, ciclo: 'uso', renova: 'contínuo', estado: 'uso' },
    { nome: 'Domínio futty.app', desc: 'Namecheap', valor: 14, ciclo: 'ano', renova: '', estado: 'ativo' },
    { nome: 'Apple Developer', desc: 'App Store (futuro)', valor: 99, ciclo: 'ano', renova: '', estado: 'ativo' },
    { nome: 'Google Play', desc: 'conta única (futuro)', valor: 25, ciclo: 'ano', renova: '', estado: 'ativo' },
  ],
  registos: [
    { nome: 'Domínio futty.app', tipo: 'Registrar · Namecheap', renova: '', dias: null },
    { nome: 'Marca "FUTTY" (INPI)', tipo: 'classe 9 · a depositar', renova: '', dias: null },
    { nome: 'Janela de prioridade (Paris)', tipo: '6 meses após depósito INPI', renova: '', dias: null },
    { nome: 'Política de privacidade', tipo: 'por publicar (LGPD / lojas)', renova: '', dias: null },
  ],
  cobertura: {
    vende: ['🇵🇹 Portugal', '🇧🇷 Brasil', 'EUR', 'BRL'],
    bloqueado: ['🇺🇸 EUA', 'USD', '+ resto por ativar no Stripe'],
  },
  campanhas: [],
  // toggle por página (default OFF). Chaves = as páginas onde há slot de publicidade.
  toggles: { inicio: false, sorteio: false, p: false },
  // Proteção de dados (LGPD/compliance) — editável à mão. Default tudo por tratar/publicar.
  protecao_dados: {
    dpas: ['Supabase', 'Railway', 'Vercel', 'fal.ai', 'Stripe', 'Anthropic'].map((nome) => ({ nome, estado: 'por tratar', data: '', link: '' })),
    politica_privacidade: { estado: 'por publicar', data: '', url: '' },
    termos_uso: { estado: 'por publicar', data: '', url: '' },
    canal_titular: { estado: 'por definir', destino: '' },
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
    custos: Array.isArray(obj?.custos) ? obj.custos : SEED.custos,
    registos: Array.isArray(obj?.registos) ? obj.registos : SEED.registos,
    cobertura: obj?.cobertura && typeof obj.cobertura === 'object' ? obj.cobertura : SEED.cobertura,
    campanhas: Array.isArray(obj?.campanhas) ? obj.campanhas : [],
    toggles: obj?.toggles && typeof obj.toggles === 'object' ? obj.toggles : SEED.toggles,
    protecao_dados: obj?.protecao_dados && typeof obj.protecao_dados === 'object' ? obj.protecao_dados : SEED.protecao_dados,
  };
  await supabase.storage.from(BUCKET).upload(CAMINHO, Buffer.from(JSON.stringify(limpo)), { contentType: 'application/json', upsert: true });
  return limpo;
}

module.exports = { ler, gravar, SEED };
