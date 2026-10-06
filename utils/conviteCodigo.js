// Futty v2.0 — O link curto do convite, futtyapp.com.br/c/<código>.
//
// O convite continua sendo uma linha de `convites` com o token longo (uuid) — o link /convite/<uuid> segue válido, igual. O
// código é só outro jeito de chegar à MESMA linha (tabela `convite_codigos`, migração 072): mesmo prazo (vale o
// `expires_at` do convite), some junto se o admin cancela o convite (ON DELETE CASCADE). Aqui vivem as quatro peças pequenas disso:
// gerar o código, reconhecê-lo, gravá-lo e achar o convite a partir de um parâmetro que pode ser uuid OU código.
//
// Alfabeto: minúsculas e números sem os que se confundem (0/o, 1/l/i): 31 símbolos; 8 posições ≈ 8,5 × 10^11 combinações.
// O link vai pro WhatsApp e às vezes é ditado: nada de maiúscula/minúscula para errar. A leitura aceita 6–8 posições e
// qualquer caixa (digitaram "K7M2P9QX" no celular).
const crypto = require('node:crypto');

const ALFABETO = '23456789abcdefghjkmnpqrstuvwxyz';
const TAMANHO = 8;
const RE_CODIGO = new RegExp(`^[${ALFABETO}]{6,8}$`);

/** Um código novo, aleatório (crypto.randomInt: sem viés de módulo). */
function gerarCodigo(tamanho = TAMANHO) {
  let saida = '';
  for (let i = 0; i < tamanho; i += 1) saida += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return saida;
}

/** O código normalizado (minúsculo, sem espaço) se tem a cara de um código; senão null (é o token longo, ou lixo). */
function lerCodigo(parametro) {
  const c = String(parametro ?? '').trim().toLowerCase();
  return RE_CODIGO.test(c) ? c : null;
}

/**
 * Grava um código para o convite e o devolve. Colisão (23505) tenta de novo com outro; qualquer outro erro — a tabela
 * ainda não existe (migração 072 por aplicar) — devolve null, e o convite segue só com o link longo. Nunca lança: o
 * convite que acabou de nascer não pode falhar por causa do link curto.
 */
async function criarCodigo(supabase, conviteId, { tentativas = 5, gerar = gerarCodigo } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const codigo = gerar();
    const { error } = await supabase.from('convite_codigos').insert({ codigo, convite_id: conviteId });
    if (!error) return codigo;
    if (error.code !== '23505') {
      console.warn('[convite] convite_codigos indisponível (migração 072 aplicada?):', error.message);
      return null;
    }
  }
  return null;
}

/**
 * O convite que o parâmetro da rota nomeia — o token longo (uuid) ou o código curto —, com as `colunas` pedidas, ou null.
 * Código: UMA ida só (o convite vem embutido, `convites ( … )`), como o caminho do uuid; sem a tabela (072 por aplicar) ou
 * sem o código, é "não encontrado". Qualquer coisa que não pareça código é tratada como token, como sempre foi.
 */
async function convitePorParametro(supabase, parametro, colunas = 'id, team_id, criado_por, expires_at') {
  const codigo = lerCodigo(parametro);
  if (codigo) {
    const { data, error } = await supabase.from('convite_codigos').select(`codigo, convites ( ${colunas} )`).eq('codigo', codigo).maybeSingle();
    if (error || !data) return null;
    const convite = Array.isArray(data.convites) ? data.convites[0] : data.convites;
    return convite || null;
  }
  const { data } = await supabase.from('convites').select(colunas).eq('token', parametro).maybeSingle();
  return data || null;
}

/** { conviteId → código } dos convites dados (best-effort: sem a tabela, mapa vazio). */
async function codigosDosConvites(supabase, conviteIds) {
  const mapa = {};
  if (!conviteIds?.length) return mapa;
  const { data, error } = await supabase.from('convite_codigos').select('codigo, convite_id').in('convite_id', conviteIds);
  if (error) return mapa;
  for (const l of data || []) mapa[l.convite_id] = l.codigo;
  return mapa;
}

module.exports = { ALFABETO, TAMANHO, gerarCodigo, lerCodigo, criarCodigo, convitePorParametro, codigosDosConvites };
