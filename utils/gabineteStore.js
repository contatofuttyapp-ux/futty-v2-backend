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
const { HttpError } = require('./http');

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
  // Aba Registros & prazos > bloco "Acessos & contas" (12-set). Onde cada peça
  // da operação mora — SÓ caminho e conta, NUNCA senha (ver validação em
  // gravar()). Senha de verdade fica no Gerenciador de Senhas do Google
  // (conta contatofuttyapp).
  acessos: [
    { id: 'gmail', servico: 'Gmail (chave-mestra)', para_que: 'Abre quase tudo abaixo; 2FA ligado, códigos de backup impressos', site: 'https://mail.google.com', entra_com: 'contatofuttyapp@gmail.com', obs: 'E-mail de recuperação: phferreiraborgesbackup@gmail.com' },
    { id: 'github', servico: 'GitHub', para_que: 'Código do app (futty-v2-frontend, futty-v2-backend)', site: 'https://github.com/contatofuttyapp-ux', entra_com: 'usuário contatofuttyapp-ux', obs: 'Pede código por e-mail em ações sensíveis' },
    { id: 'supabase', servico: 'Supabase', para_que: 'Banco, login dos usuários, fotos, e-mails de auth', site: 'https://supabase.com/dashboard/project/ynzmjcvqdljffgbeqglh', entra_com: 'conta ligada ao Gmail contatofuttyapp', obs: 'Projeto futty-v2, São Paulo. Plano Free → Pro (a fazer)' },
    { id: 'google-cloud', servico: 'Google Cloud', para_que: 'Motor do app (Cloud Run futty-api), login Google do app, faturamento', site: 'https://console.cloud.google.com/run?project=futty-495914', entra_com: 'contatofuttyapp@gmail.com', obs: 'Avaliação até 10/12/2026: ativar conta completa antes. Orçamento €9/mês com alertas' },
    { id: 'cloudflare', servico: 'Cloudflare Pages', para_que: 'Telas do app (futty.pages.dev)', site: 'https://dash.cloudflare.com', entra_com: 'contatofuttyapp@gmail.com + senha própria (no Chrome)', obs: 'Projeto "futty"; produção = ramo main, preview = dev' },
    { id: 'resend', servico: 'Resend', para_que: 'Envio dos e-mails do app (nao-responda@futtyapp.com)', site: 'https://resend.com/emails', entra_com: 'Continue with Google (contatofuttyapp)', obs: 'Domínio futtyapp.com verificado, região São Paulo. Grátis até 3.000/mês' },
    { id: 'fal-ai', servico: 'fal.ai', para_que: 'IA que gera a figurinha (pré-pago)', site: 'https://fal.ai/dashboard', entra_com: '', obs: 'Ativar limite de gasto mensal' },
    { id: 'sentry', servico: 'Sentry', para_que: 'Erros do app em produção', site: 'https://sentry.io', entra_com: '', obs: 'Projetos futty-frontend / backend' },
    { id: 'porkbun', servico: 'Porkbun', para_que: 'Domínio futtyapp.com e DNS', site: 'https://porkbun.com/account/domainsSpeedy', entra_com: 'usuário futtyapp', obs: 'Renova 25/08/2027. Ligar 2FA' },
    { id: 'registrobr', servico: 'Registro.br', para_que: 'Domínio futtyapp.com.br', site: 'https://registro.br', entra_com: 'CPF / gov.br, código PHFBO37', obs: 'Renova 24/08/2027' },
    { id: 'inpi', servico: 'INPI (e-INPI)', para_que: 'Marca FUTTY, processo 944951872', site: 'https://gru.inpi.gov.br', entra_com: 'login e-INPI', obs: 'Acompanhar RPI; oposição 60 dias após publicação' },
    { id: 'wise', servico: 'Wise', para_que: 'Cartão usado no Google Cloud', site: 'https://wise.com', entra_com: '(conta pessoal do Pedro)', obs: 'Manter saldo ≥ US$20 no fim do mês quando a conta completa estiver ativa' },
    { id: 'claude', servico: 'Claude (Cowork + Claude Code)', para_que: 'Ferramenta de trabalho', site: 'https://claude.ai', entra_com: 'phferreiraborgesbackup@gmail.com', obs: '2FA recomendado' },
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
  // Interruptor geral (Gabinete 2.0, aba Anúncios): desligado corta TODA a
  // publicidade, independente dos interruptores por página abaixo. Default
  // ligado — quem decide página a página são os toggles por página, que
  // continuam default OFF.
  ads_ativo: true,
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

// Acessos & contas (12-set): NUNCA existe campo de senha — se algo parecido
// com senha/chave for colado no campo `obs`, a gravação inteira é recusada
// (fail-closed: melhor devolver 400 do que guardar um segredo em texto claro
// num JSON no Storage). Padrões: prefixos de chave conhecidos (re_ Resend,
// sk_ Stripe/OpenAI/etc., eyJ início de um JWT em base64) ou qualquer "palavra"
// (sem espaço) com mais de 40 caracteres — o comprimento típico de tokens/hashes.
function pareceSegredo(texto) {
  if (!texto) return false;
  if (/^(re_|sk_|eyJ)/.test(texto)) return true;
  if (/\S{41,}/.test(texto)) return true;
  return false;
}

function validarAcessos(lista) {
  for (const a of lista) {
    if (pareceSegredo(a?.obs)) {
      throw new HttpError(400, 'Senhas não entram aqui. Guarde no Gerenciador de Senhas do Google.');
    }
  }
  return lista;
}

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
  const acessos = Array.isArray(obj?.acessos) ? obj.acessos : SEED.acessos;
  validarAcessos(acessos); // lança HttpError(400) se algum `obs` parecer senha/chave

  const limpo = {
    custos_fixos: Array.isArray(obj?.custos_fixos) ? obj.custos_fixos : SEED.custos_fixos,
    registros: Array.isArray(obj?.registros) ? obj.registros : SEED.registros,
    acessos,
    seguranca_manual: obj?.seguranca_manual && typeof obj.seguranca_manual === 'object' ? obj.seguranca_manual : SEED.seguranca_manual,
    cobertura: obj?.cobertura && typeof obj.cobertura === 'object' ? obj.cobertura : SEED.cobertura,
    campanhas: Array.isArray(obj?.campanhas) ? obj.campanhas : [],
    ads_ativo: typeof obj?.ads_ativo === 'boolean' ? obj.ads_ativo : SEED.ads_ativo,
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
