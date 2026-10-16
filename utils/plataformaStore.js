// Futty v2.0 — Store de PLATAFORMA (poderes da Super sobre contas/equipas).
// LEI DO DONO: a Super age sobre a PLATAFORMA (suspender contas/equipas), NUNCA
// sobre o CONTEÚDO (notas, votos, fotos). Aqui só vivem IDs suspensos — zero PII,
// zero conteúdo. Mesmo padrão do gabinete/denúncias: JSON no bucket privado
// `denuncias`, SEM DDL. Cache em memória (TTL curto) porque a gate corre em CADA
// pedido autenticado — suspensões são raras, por isso o custo é ~nulo.
const { supabase } = require('./db');
const { criarCache } = require('./cacheQuente');
const { comPrazo } = require('./comPrazo');
const { HttpError } = require('./http');

const BUCKET = 'denuncias';
const CAMINHO = '_plataforma/suspensoes.json';
const TTL_MS = 15000; // 15s — coerência "quase-imediata" sem download por pedido

const VAZIO = { users: [], equipas: [] };
// No arranque frio, os 3 pedidos simultâneos do app
// esperam o mesmo download deste arquivo (em vez de o baixar 3 vezes).
// E passados os 15 s ninguém mais espera: sai a lista conhecida e o download
// novo corre por trás. Numa instância parada há horas, uma suspensão feita por
// OUTRA instância vale a partir do segundo pedido, não do primeiro.
const CHAVE = 'suspensoes';
const cache = criarCache({ nome: 'plataforma', ttlMs: TTL_MS, max: 1 });

function normalizar(o) {
  return {
    users: Array.isArray(o?.users) ? o.users.filter(Boolean) : [],
    equipas: Array.isArray(o?.equipas) ? o.equipas.filter(Boolean) : [],
  };
}

// O arquivo muda a cada suspensão e é lido logo depois (lê → acrescenta um id → grava). O CDN do Supabase guarda por 1 h o que
// sobe sem `cacheControl` e devolve essa cópia a quem baixa: a 2ª suspensão lia a lista de ANTES da 1ª e gravava por cima — a 1ª
// conta voltava a "Ativa" sozinha. Por isso o arquivo sobe com `cacheControl: '0'` e toda leitura leva um `cacheNonce` (fura a
// cópia que o CDN ainda tenha de antes).
const MSG_SEM_LEITURA = 'Não deu para ler as suspensões agora. Nada foi alterado; tente de novo em instantes.';
const MSG_SEM_GRAVACAO = 'Não deu para gravar a suspensão agora. Tente de novo em instantes.';
const nonce = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const arquivoNaoExiste = (e) => String(e?.statusCode) === '404' || Number(e?.status) === 404 || /not.?found/i.test(String(e?.message || ''));

// Lê SEMPRE do Storage, sem cache nenhum (nem o nosso, nem o do CDN). Prazo de 3 s (comPrazo) — sem ele, uma ida sem resposta
// prende quem chama para sempre; o catch não protege contra uma promessa pendurada.
//   · `estrito: false` (a gate de cada pedido): fail-open — erro → estado vazio, não tranca ninguém.
//   · `estrito: true` (antes de gravar): erro → 503 e nada é gravado. Ler "vazio" por um soluço do Storage e gravar por cima
//     apagaria TODAS as suspensões. Só o arquivo que ainda não existe (primeiro uso) conta como vazio.
async function lerRaw({ estrito = false } = {}) {
  try {
    const { data, error } = await comPrazo(supabase.storage.from(BUCKET).download(CAMINHO, { cacheNonce: nonce() }), 3000, 'plataforma/suspensoes');
    if (error) {
      if (arquivoNaoExiste(error)) return { ...VAZIO };
      throw error;
    }
    if (!data) return { ...VAZIO };
    return normalizar(JSON.parse(await data.text()));
  } catch (e) {
    if (estrito) {
      console.error('[plataforma] leitura das suspensões falhou antes de gravar:', e?.message || e);
      throw new HttpError(503, MSG_SEM_LEITURA, 'SUSPENSOES_INDISPONIVEIS');
    }
    return { ...VAZIO };
  }
}

// Lê com cache (TTL). Usado pela gate de cada pedido.
async function ler() {
  return cache.obter(CHAVE, lerRaw);
}

async function gravar(obj) {
  const limpo = {
    users: [...new Set(normalizar(obj).users)],
    equipas: [...new Set(normalizar(obj).equipas)],
  };
  let error;
  try {
    ({ error } = await comPrazo(supabase.storage
      .from(BUCKET)
      .upload(CAMINHO, Buffer.from(JSON.stringify(limpo)), { contentType: 'application/json', upsert: true, cacheControl: '0' }), 5000, 'plataforma/gravar'));
  } catch (e) {
    error = e;
  }
  if (error) {
    console.error('[plataforma] gravação das suspensões falhou:', error?.message || error);
    throw new HttpError(503, MSG_SEM_GRAVACAO, 'SUSPENSOES_INDISPONIVEIS');
  }
  cache.definir(CHAVE, limpo); // atualiza já → efeito imediato
  return limpo;
}

async function definirUser(userId, suspenso) {
  const s = await lerRaw({ estrito: true });
  const set = new Set(s.users);
  if (suspenso) set.add(userId); else set.delete(userId);
  await gravar({ users: [...set], equipas: s.equipas });
  return suspenso;
}

async function definirEquipa(teamId, suspensa) {
  const s = await lerRaw({ estrito: true });
  const set = new Set(s.equipas);
  if (suspensa) set.add(teamId); else set.delete(teamId);
  await gravar({ users: s.users, equipas: [...set] });
  return suspensa;
}

async function userSuspenso(userId) {
  return (await ler()).users.includes(userId);
}

async function equipaSuspensa(teamId) {
  return (await ler()).equipas.includes(teamId);
}

// Conjuntos (para listagens do painel — marcar estado sem N chamadas).
async function conjuntos() {
  const s = await ler();
  return { users: new Set(s.users), equipas: new Set(s.equipas) };
}

module.exports = { ler, definirUser, definirEquipa, userSuspenso, equipaSuspensa, conjuntos };
