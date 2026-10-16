// Futty v2.0 — O log de ações do Gabinete: quem suspendeu, reativou ou excluiu qual conta, e quando. Só acrescenta (nunca edita uma linha),
// guarda as últimas MAX ações. Mesmo padrão dos outros arquivos de plataforma (JSON no bucket privado `denuncias`, sem DDL) e sem cache no
// CDN (cacheControl '0' e cacheNonce — ver utils/plataformaStore.js: uma cópia velha na leitura apagaria a ação anterior ao gravar).
//
// O que entra: o id da conta, o apelido e o e-mail MASCARADO ("phf…@gmail.com"). A conta excluída pediu, por definição, para sumir: o log
// diz que ela saiu e quem a tirou, não guarda os dados dela.
const { supabase } = require('./db');
const { comPrazo } = require('./comPrazo');

const BUCKET = 'denuncias';
const CAMINHO = '_plataforma/acoes.json';
const MAX = 500;

const nonce = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const naoExiste = (e) => String(e?.statusCode) === '404' || Number(e?.status) === 404 || /not.?found/i.test(String(e?.message || ''));

async function lerTudo() {
  const { data, error } = await comPrazo(supabase.storage.from(BUCKET).download(CAMINHO, { cacheNonce: nonce() }), 3000, 'gabinete/acoes');
  if (error) {
    if (naoExiste(error)) return [];
    throw new Error(error.message || 'leitura do log de ações falhou');
  }
  if (!data) return [];
  const o = JSON.parse(await data.text());
  return Array.isArray(o?.acoes) ? o.acoes : [];
}

/**
 * Acrescenta uma ação. Nunca lança: a ação em si (suspender, excluir) já aconteceu, e um log que falhou não pode desfazê-la nem
 * esconder dela o "pronto". Devolve true se gravou.
 * @param {{ acao: string, por: { id: string, nome?: string }, alvo: { id: string, apelido?: string|null, email?: string }, detalhe?: object }} a
 */
async function registrar(a) {
  try {
    const acoes = await lerTudo();
    acoes.push({ em: new Date().toISOString(), ...a });
    const corpo = Buffer.from(JSON.stringify({ acoes: acoes.slice(-MAX) }));
    const { error } = await comPrazo(supabase.storage.from(BUCKET).upload(CAMINHO, corpo, { contentType: 'application/json', upsert: true, cacheControl: '0' }), 5000, 'gabinete/acoes');
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.error('[gabinete] log de ações não gravou:', e?.message || e, a?.acao, a?.alvo?.id);
    return false;
  }
}

/** As últimas `n` ações, a mais recente primeiro. */
async function ultimas(n = 30) {
  const acoes = await lerTudo();
  return acoes.slice(-n).reverse();
}

module.exports = { registrar, ultimas, MAX };
