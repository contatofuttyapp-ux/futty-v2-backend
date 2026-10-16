// Futty v2.0 — CONVITE PENDENTE NO MOTOR: o convite que atravessa a instalação do app.
//
// O convite aberto no navegador do celular fica no armazenamento do navegador; o app instalado pela loja tem o seu, vazio, e a
// pessoa terminava o cadastro sem time. Por isso a página do convite, no navegador de um celular, avisa o motor: aqui se guarda
// { convite, plataforma, rede } por no máximo 2 h (tabela `convites_pendentes`, migração 084). Quando alguém termina o cadastro no
// app sem time, o app pergunta: os convites da MESMA rede e da MESMA plataforma, abertos nas últimas 2 h, são os dela.
//
// A rede é o IP de quem pediu, nunca guardado: só o HMAC dele. IPv4 vale inteiro (o NAT da casa ou da operadora); IPv6 vale pelo
// prefixo /64 (o aparelho troca o resto do endereço a cada conexão, por privacidade; o /64 é o da rede onde ele está). A chave do
// HMAC deriva do segredo do motor: quem lê o banco não consegue voltar do hash para o IP testando os 4 bilhões de IPv4.
//
// O motor vê o IP real nos dois lados: o site chega pela Cloudflare (CF-Connecting-IP, utils/cloudflareIps.js) e o app chega direto.
// Sem a migração 084 tudo falha em silêncio (um aviso no log): o convite segue pelo link copiado, pelo cartão do Início e pelo Gabinete.
const crypto = require('node:crypto');
const net = require('node:net');
const { supabase } = require('./db');
const { chaveSecreta } = require('./chavesSupabase');

const VALIDADE_MS = 2 * 60 * 60 * 1000;
const PLATAFORMAS = ['ios', 'android'];

let avisou = false;
function avisar(mensagem) {
  if (avisou) return;
  avisou = true;
  console.warn('[convitePendente] tabela convites_pendentes indisponível (migração 084 aplicada?):', mensagem);
}

/** 'ios' | 'android' | null. */
function plataformaValida(valor) {
  const p = String(valor ?? '').trim().toLowerCase();
  return PLATAFORMAS.includes(p) ? p : null;
}

/** Os 8 grupos de um IPv6, por extenso e em minúsculas (null se não for IPv6). */
function gruposDoIpv6(ip) {
  if (net.isIPv6(ip) !== true) return null;
  let texto = ip.toLowerCase().split('%')[0];
  // IPv4 no fim (::ffff:1.2.3.4): vira dois grupos hexadecimais.
  const v4 = texto.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    texto = texto.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [esq, dir] = texto.includes('::') ? texto.split('::') : [texto, null];
  const a = esq ? esq.split(':') : [];
  const b = dir ? dir.split(':') : [];
  const meio = dir === null ? [] : new Array(8 - a.length - b.length).fill('0');
  return [...a, ...meio, ...b].map((g) => g.padStart(4, '0'));
}

/** O pedaço do IP que identifica a rede: o IPv4 inteiro, ou o /64 do IPv6. IPv4 dentro de IPv6 (::ffff:a.b.c.d) é IPv4. */
function redeDoIp(ip) {
  const texto = String(ip ?? '').trim();
  if (net.isIPv4(texto)) return `v4:${texto}`;
  const grupos = gruposDoIpv6(texto);
  if (!grupos) return null;
  if (grupos.slice(0, 6).join(':') === '0000:0000:0000:0000:0000:ffff') {
    const n = parseInt(grupos[6], 16);
    const m = parseInt(grupos[7], 16);
    return `v4:${n >> 8}.${n & 255}.${m >> 8}.${m & 255}`;
  }
  return `v6:${grupos.slice(0, 4).join(':')}::/64`;
}

let chaveDoHmac = null;
function chave() {
  if (!chaveDoHmac) chaveDoHmac = crypto.createHash('sha256').update(`futty:convite-pendente:${chaveSecreta()}`).digest();
  return chaveDoHmac;
}

/** O HMAC da rede do IP (hex), ou null se o IP não é IP. */
function hashDaRede(ip) {
  const rede = redeDoIp(ip);
  return rede ? crypto.createHmac('sha256', chave()).update(rede).digest('hex') : null;
}

/** Apaga as linhas vencidas (best-effort; nunca lança). */
async function limparVencidos(agora) {
  const { error } = await supabase.from('convites_pendentes').delete().lt('criado_em', new Date(agora - VALIDADE_MS).toISOString());
  if (error) avisar(error.message);
}

/**
 * Guarda o convite aberto nesta rede e plataforma (ou renova o horário, se já estava). Devolve true se gravou. Nunca lança: o aviso é um
 * bônus — falhar aqui não pode estragar a página do convite.
 */
async function registrarPendente({ conviteId, ip, plataforma, agora = Date.now() }) {
  const p = plataformaValida(plataforma);
  const rede = hashDaRede(ip);
  if (!conviteId || !p || !rede) return false;
  try {
    const { error } = await supabase
      .from('convites_pendentes')
      .upsert({ convite_id: conviteId, rede, plataforma: p, criado_em: new Date(agora).toISOString() }, { onConflict: 'convite_id,rede,plataforma' });
    if (error) { avisar(error.message); return false; }
    await limparVencidos(agora);
    return true;
  } catch (e) {
    avisar(e.message);
    return false;
  }
}

/** Os ids dos convites abertos nesta rede e plataforma nas últimas 2 h, do mais recente ao mais antigo, sem repetir. Nunca lança. */
async function pendentesDaRede({ ip, plataforma, agora = Date.now() }) {
  const p = plataformaValida(plataforma);
  const rede = hashDaRede(ip);
  if (!p || !rede) return [];
  try {
    const { data, error } = await supabase
      .from('convites_pendentes')
      .select('convite_id, criado_em')
      .eq('rede', rede)
      .eq('plataforma', p)
      .gte('criado_em', new Date(agora - VALIDADE_MS).toISOString())
      .order('criado_em', { ascending: false })
      .limit(20);
    if (error) { avisar(error.message); return []; }
    limparVencidos(agora).catch(() => {});
    return [...new Set((data || []).map((l) => l.convite_id).filter(Boolean))];
  } catch (e) {
    avisar(e.message);
    return [];
  }
}

module.exports = { VALIDADE_MS, plataformaValida, redeDoIp, hashDaRede, registrarPendente, pendentesDaRede };
