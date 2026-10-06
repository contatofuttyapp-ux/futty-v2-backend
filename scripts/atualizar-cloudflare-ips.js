#!/usr/bin/env node
// Futty v2.0 — Regenera as faixas de IP da Cloudflare embutidas em utils/cloudflareIps.js.
//
// A Cloudflare publica as faixas em https://www.cloudflare.com/ips-v4 e /ips-v6 (um CIDR por linha). O
// motor só honra o CF-Connecting-IP quando o pedido vem de uma delas (ver o cabeçalho de utils/cloudflareIps.js);
// se a Cloudflare acrescentar uma faixa e a lista ficar velha, o site inteiro cai num balde de rate limit só.
// Este script NÃO roda sozinho (nem no build, nem no arranque): rode à mão de vez em quando — e sempre que o
// log do motor disser "CF-Connecting-IP ignorado" sem motivo —, olhe o `git diff` e publique.
//
// Só reescreve o trecho entre os marcadores <faixas-da-cloudflare>; o resto do arquivo não é tocado.
// Se a Cloudflare devolver algo que não parece a lista (erro, página, lista curta demais), não escreve nada.
//
// Uso: node scripts/atualizar-cloudflare-ips.js
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'utils', 'cloudflareIps.js');
const URL_V4 = 'https://www.cloudflare.com/ips-v4';
const URL_V6 = 'https://www.cloudflare.com/ips-v6';
const ABRE = '// <faixas-da-cloudflare>';
const FECHA = '// </faixas-da-cloudflare>';
// A lista de hoje tem ~15 faixas v4 e ~7 v6; abaixo disto a resposta não é a lista.
const MINIMO_V4 = 8;
const MINIMO_V6 = 3;

/** O texto da Cloudflare (um CIDR por linha) → CIDRs válidos da família pedida; lança se algo não for CIDR. */
function lerFaixas(texto, familia) {
  const faixas = String(texto).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const faixa of faixas) {
    const [base, bits, resto] = faixa.split('/');
    const maximo = familia === 4 ? 32 : 128;
    const ok = resto === undefined && net.isIP(base) === familia && /^\d{1,3}$/.test(bits ?? '') && Number(bits) <= maximo;
    if (!ok) throw new Error(`"${faixa}" não é um CIDR IPv${familia}`);
  }
  return faixas;
}

/** O trecho gerado, com a data em que a lista foi copiada. */
function montarBloco({ v4, v6, data }) {
  const lista = (faixas) => faixas.map((f) => `  '${f}',`).join('\n');
  return [
    ABRE + ' — GERADO por scripts/atualizar-cloudflare-ips.js; não edite à mão.',
    `const COPIADO_EM = '${data}'; // https://www.cloudflare.com/ips-v4 e /ips-v6`,
    'const FAIXAS_V4 = [',
    lista(v4),
    '];',
    'const FAIXAS_V6 = [',
    lista(v6),
    '];',
    FECHA,
  ].join('\n');
}

/** Troca o trecho entre os marcadores, sem mexer no resto (e sem mexer no fim de linha do arquivo). */
function substituirBloco(fonte, bloco) {
  const fimDeLinha = fonte.includes('\r\n') ? '\r\n' : '\n';
  const inicio = fonte.indexOf(ABRE);
  const fim = fonte.indexOf(FECHA);
  if (inicio < 0 || fim < inicio) throw new Error(`os marcadores ${ABRE} … ${FECHA} não estão em ${path.basename(ARQUIVO)}`);
  return fonte.slice(0, inicio) + bloco.replace(/\n/g, fimDeLinha) + fonte.slice(fim + FECHA.length);
}

async function baixar(url) {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resposta.ok) throw new Error(`${url} respondeu ${resposta.status}`);
  return resposta.text();
}

async function main() {
  const v4 = lerFaixas(await baixar(URL_V4), 4);
  const v6 = lerFaixas(await baixar(URL_V6), 6);
  if (v4.length < MINIMO_V4 || v6.length < MINIMO_V6) throw new Error(`a Cloudflare devolveu ${v4.length} faixas v4 e ${v6.length} v6: curto demais para ser a lista`);
  const antes = fs.readFileSync(ARQUIVO, 'utf8');
  const depois = substituirBloco(antes, montarBloco({ v4, v6, data: new Date().toISOString().slice(0, 10) }));
  if (depois === antes) return console.log('Nada mudou: a lista embutida já é a da Cloudflare.');
  fs.writeFileSync(ARQUIVO, depois);
  console.log(`utils/cloudflareIps.js atualizado: ${v4.length} faixas IPv4 e ${v6.length} IPv6. Confira com \`git diff\` e rode os testes antes de publicar.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Não atualizei nada: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { lerFaixas, montarBloco, substituirBloco, ABRE, FECHA };
