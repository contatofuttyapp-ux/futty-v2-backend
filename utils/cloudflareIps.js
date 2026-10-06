// Futty v2.0 — As faixas de IP da Cloudflare e a regra de quando o CF-Connecting-IP vale.
//
// O site (futtyapp.com.br) fala com o motor por uma função da Cloudflare (frontend/functions/api/[[path]].js);
// visto do Cloud Run, todo pedido do site chega do MESMO endereço, o do edge, e o IP de verdade vem no
// cabeçalho CF-Connecting-IP. Mas o cabeçalho é texto: quem bate direto na URL pública do Cloud Run escreve o
// que quiser nele e ganha um balde de rate limit novo a cada valor. Por isso o cabeçalho só é honrado quando o
// pedido VEIO da Cloudflare: o endereço que o Google viu (req.ip, com trust proxy = 1) tem de estar nas faixas
// que a própria Cloudflare publica. Fora delas, vale o req.ip e o cabeçalho é ignorado.
//
// Sem variável de ambiente de propósito: configuração que falta não pode virar "Muitos pedidos" falso no site
// inteiro. O risco que sobra é a lista ficar velha (a Cloudflare acrescenta faixa de vez em quando): o site
// inteiro cairia no balde do edge. Duas redes de segurança: o aviso no log (abaixo) e o script que regenera a
// lista (scripts/atualizar-cloudflare-ips.js, que NÃO roda sozinho — rode e confira o diff antes de publicar).
const net = require('node:net');

// <faixas-da-cloudflare> — GERADO por scripts/atualizar-cloudflare-ips.js; não edite à mão.
const COPIADO_EM = '2026-10-06'; // https://www.cloudflare.com/ips-v4 e /ips-v6
const FAIXAS_V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const FAIXAS_V6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
// </faixas-da-cloudflare>

const lista = new net.BlockList();
for (const faixa of FAIXAS_V4) { const [base, bits] = faixa.split('/'); lista.addSubnet(base, Number(bits), 'ipv4'); }
for (const faixa of FAIXAS_V6) { const [base, bits] = faixa.split('/'); lista.addSubnet(base, Number(bits), 'ipv6'); }

/** O endereço (IPv4, IPv6 ou IPv4 dentro de IPv6, "::ffff:173.245.48.5") é de uma faixa da Cloudflare? */
function ehIpDaCloudflare(ip) {
  const familia = net.isIP(String(ip ?? ''));
  if (!familia) return false;
  try {
    return lista.check(ip, familia === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return false; // endereço que o Node aceita como IP mas a lista não sabe comparar (escopo "%eth0")
  }
}

// Um aviso por 10 min no máximo (e a contagem do que ficou de fora): forjar o cabeçalho é de graça, o log não pode virar alvo.
const INTERVALO_DO_AVISO_MS = 10 * 60 * 1000;
let ultimoAviso = 0;
let ignoradosDesdeOAviso = 0;

function avisarCabecalhoIgnorado(ip, { agora, avisar }) {
  ignoradosDesdeOAviso += 1;
  if (agora() - ultimoAviso < INTERVALO_DO_AVISO_MS) return;
  avisar(`[limiter] CF-Connecting-IP ignorado em ${ignoradosDesdeOAviso} pedido(s); o último veio de ${ip}, que não é da Cloudflare ` +
    `(cabeçalho forjado — ou a lista de faixas está velha: rode scripts/atualizar-cloudflare-ips.js, copiada em ${COPIADO_EM}).`);
  ultimoAviso = agora();
  ignoradosDesdeOAviso = 0;
}

/**
 * O IP real de quem pediu: o CF-Connecting-IP quando o pedido veio da Cloudflare; senão o req.ip.
 * `agora` e `avisar` são injetáveis só para o teste.
 */
function ipRealDoPedido(req, { agora = Date.now, avisar = console.warn } = {}) {
  const doCabecalho = req.get('cf-connecting-ip')?.trim();
  if (!doCabecalho) return req.ip;
  if (!ehIpDaCloudflare(req.ip)) {
    avisarCabecalhoIgnorado(req.ip, { agora, avisar });
    return req.ip;
  }
  // Da Cloudflare mas sem cara de IP (nunca acontece): o req.ip é o que se sabe de verdade.
  return net.isIP(doCabecalho) ? doCabecalho : req.ip;
}

/** Só para os testes: esquece o aviso já dado. */
function esquecerAvisos() {
  ultimoAviso = 0;
  ignoradosDesdeOAviso = 0;
}

module.exports = { ehIpDaCloudflare, ipRealDoPedido, esquecerAvisos, COPIADO_EM, FAIXAS_V4, FAIXAS_V6, INTERVALO_DO_AVISO_MS };
