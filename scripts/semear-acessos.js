#!/usr/bin/env node
// Futty v2.0 — Semeia a tabela "Acessos & contas" do Gabinete a partir do CONTAS.md.
//
// O CONTAS.md (raiz do FUT, da Freaky) é onde cada conta da operação mora — SEM senhas. O Gabinete
// (aba Registros → "Acessos & contas") é o espelho no app. Este script leva do arquivo para lá só o que
// é caminho, nunca segredo: serviço, para quê, site, entra com e o custo €/mês. A coluna 2FA fica no
// arquivo. Tudo passa pela mesma trava do Gabinete (gabineteStore.gravar → validarAcessos): se algo
// parecer senha ou chave, a gravação inteira é recusada.
//
// Grava no Storage de verdade (o mesmo do app): quem roda é o Pedro, de propósito.
//
//   node scripts/semear-acessos.js                 simula: lê o CONTAS.md e o Gabinete e diz o que faria
//   node scripts/semear-acessos.js --gravar        grava — só se a tabela estiver VAZIA
//   node scripts/semear-acessos.js --gravar --completar
//                                                  com a tabela já cheia: acrescenta os serviços que
//                                                  faltam e preenche só os campos VAZIOS (nunca troca
//                                                  o que já está lá — o dono pode ter editado à mão)
//   --arquivo <caminho>                            outro CONTAS.md (padrão: FUT\CONTAS.md)
//   --sem-banco                                    só lê o CONTAS.md e mostra as linhas (não toca em nada)
const fs = require('fs');
const path = require('path');

const ARQUIVO_PADRAO = path.join(__dirname, '..', '..', '..', 'CONTAS.md');

// Os serviços conhecidos: o id (o mesmo do SEED do gabineteStore, para casar com a linha que já existe)
// e o site, que o CONTAS.md não tem. A chave é o começo do nome do serviço no arquivo, sem acento.
const CONHECIDOS = [
  { chave: 'gmail contatofuttyapp', id: 'gmail', site: 'https://mail.google.com' },
  { chave: 'apple developer', id: 'apple', site: 'https://appstoreconnect.apple.com' },
  { chave: 'google play console', id: 'google-play', site: 'https://play.google.com/console' },
  { chave: 'google cloud', id: 'google-cloud', site: 'https://console.cloud.google.com/run?project=futty-495914' },
  { chave: 'google payments', id: 'google-payments', site: 'https://pay.google.com' },
  { chave: 'github', id: 'github', site: 'https://github.com/contatofuttyapp-ux' },
  { chave: 'supabase', id: 'supabase', site: 'https://supabase.com/dashboard/project/ynzmjcvqdljffgbeqglh' },
  { chave: 'fal.ai', id: 'fal-ai', site: 'https://fal.ai/dashboard' },
  { chave: 'cloudflare', id: 'cloudflare', site: 'https://dash.cloudflare.com' },
  { chave: 'resend', id: 'resend', site: 'https://resend.com/emails' },
  { chave: 'sentry', id: 'sentry', site: 'https://sentry.io' },
  { chave: 'meu escritorio virtual', id: 'mev', site: '' },
  { chave: 'fiverr', id: 'fiverr', site: 'https://www.fiverr.com' },
  { chave: 'microsoft teams', id: 'microsoft-teams', site: '' },
  { chave: 'gmail phferreiraborgesbackup', id: 'gmail-pessoal', site: 'https://mail.google.com' },
  { chave: 'microsoft', id: 'microsoft', site: 'https://account.microsoft.com' },
  { chave: 'porkbun', id: 'porkbun', site: 'https://porkbun.com/account/domainsSpeedy' },
  { chave: 'registro.br', id: 'registrobr', site: 'https://registro.br' },
  { chave: 'inpi', id: 'inpi', site: 'https://gru.inpi.gov.br' },
  { chave: 'claude', id: 'claude', site: 'https://claude.ai' },
  { chave: 'banco inter', id: 'banco-inter', site: 'https://inter.co' },
  { chave: 'wise', id: 'wise', site: 'https://wise.com' },
];

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slug = (t) => semAcento(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** O custo como texto de tela: sem o negrito do Markdown e sem pedaço de cartão ("cartão ••2419"). */
function limparCusto(texto) {
  return String(texto || '')
    .replace(/\*\*/g, '')
    .replace(/[;,]?\s*cart[aã]o[^);]*/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** As linhas das tabelas do CONTAS.md: { servico, para_que, entra_com, custo } (a coluna 2FA fica de fora). */
function lerContas(markdown) {
  const linhas = [];
  let cabecalho = null;
  for (const bruta of String(markdown).split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha.startsWith('|')) { cabecalho = null; continue; }
    const celulas = linha.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (!cabecalho) { cabecalho = celulas.map(semAcento); continue; }
    if (celulas.every((c) => /^:?-{3,}:?$/.test(c))) continue; // a linha |---|---|
    const col = (nome) => celulas[cabecalho.findIndex((c) => c.startsWith(nome))] ?? '';
    const servico = col('servico');
    if (!servico) continue;
    linhas.push({ servico, para_que: col('para que'), entra_com: col('entra com'), custo: col('custo') });
  }
  return linhas;
}

/** A linha do Gabinete para uma conta do arquivo — só caminho e custo; `obs` fica vazia. */
function paraAcesso(conta) {
  const nome = semAcento(conta.servico);
  const conhecido = CONHECIDOS.find((k) => nome.startsWith(k.chave));
  return {
    id: conhecido?.id || slug(conta.servico),
    servico: conta.servico,
    para_que: conta.para_que,
    site: conhecido?.site || '',
    entra_com: conta.entra_com,
    custo_eur: limparCusto(conta.custo),
    obs: '',
  };
}

/**
 * Junta as contas do arquivo à tabela que já existe: casa pelo id (o do SEED) ou pelo nome idêntico —
 * nada de palpite; na que já existe só preenche campo VAZIO; a que falta entra no fim.
 * Devolve { lista, novas, preenchidas }.
 */
function completar(existentes, contas) {
  const lista = existentes.map((a) => ({ ...a }));
  let novas = 0;
  let preenchidas = 0;
  for (const conta of contas) {
    const nova = paraAcesso(conta);
    const alvo = lista.find((a) => a.id === nova.id) || lista.find((a) => semAcento(a.servico) === semAcento(nova.servico));
    if (!alvo) {
      lista.push(nova);
      novas += 1;
      continue;
    }
    for (const campo of ['para_que', 'site', 'entra_com', 'custo_eur']) {
      if (!String(alvo[campo] || '').trim() && nova[campo]) {
        alvo[campo] = nova[campo];
        preenchidas += 1;
      }
    }
  }
  return { lista, novas, preenchidas };
}

function opcao(args, nome) {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const arquivo = opcao(args, '--arquivo') || ARQUIVO_PADRAO;
  const contas = lerContas(fs.readFileSync(arquivo, 'utf8'));
  const acessos = contas.map(paraAcesso);
  console.log(`[semear-acessos] ${contas.length} conta(s) em ${arquivo}:`);
  for (const a of acessos) console.log(`   · ${a.servico} — ${a.custo_eur || 'grátis'}${a.site ? '' : ' (sem site conhecido)'}`);
  if (args.includes('--sem-banco')) return;

  require('dotenv').config({ quiet: true });
  // eslint-disable-next-line global-require
  const gabineteStore = require('../utils/gabineteStore');
  const op = await gabineteStore.lerRaw(); // sem cache: é o que está gravado agora
  const atuais = Array.isArray(op.acessos) ? op.acessos : [];
  const gravar = args.includes('--gravar');

  if (!atuais.length) {
    console.log(`[semear-acessos] a tabela está VAZIA → ${gravar ? 'gravando' : 'gravaria'} ${acessos.length} linha(s).`);
    if (gravar) await gabineteStore.gravar({ ...op, acessos });
  } else {
    const { lista, novas, preenchidas } = completar(atuais, contas);
    console.log(`[semear-acessos] a tabela já tem ${atuais.length} linha(s): completar acrescentaria ${novas} serviço(s) e preencheria ${preenchidas} campo(s) vazio(s).`);
    if (!args.includes('--completar')) {
      console.log('[semear-acessos] nada gravado (tabela cheia). Para completar sem trocar o que existe: --gravar --completar');
      return;
    }
    if (gravar) await gabineteStore.gravar({ ...op, acessos: lista });
  }
  console.log(gravar ? '[semear-acessos] ✅ gravado. Confira no Gabinete → Registros → Acessos & contas.' : '[semear-acessos] simulação: nada foi gravado (use --gravar).');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[semear-acessos] ❌', e.message);
    process.exit(1);
  });
}

module.exports = { lerContas, paraAcesso, completar, limparCusto };
