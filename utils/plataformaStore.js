// Futty v2.0 — Store de PLATAFORMA (poderes da Super sobre contas/equipas).
// LEI DO DONO: a Super age sobre a PLATAFORMA (suspender contas/equipas), NUNCA
// sobre o CONTEÚDO (notas, votos, fotos). Aqui só vivem IDs suspensos — zero PII,
// zero conteúdo. Mesmo padrão do gabinete/denúncias: JSON no bucket privado
// `denuncias`, SEM DDL. Cache em memória (TTL curto) porque a gate corre em CADA
// pedido autenticado — suspensões são raras, por isso o custo é ~nulo.
const { supabase } = require('./db');

const BUCKET = 'denuncias';
const CAMINHO = '_plataforma/suspensoes.json';
const TTL_MS = 15000; // 15s — coerência "quase-imediata" sem download por pedido

const VAZIO = { users: [], equipas: [] };
let _cache = null;
let _cacheAt = 0;

function normalizar(o) {
  return {
    users: Array.isArray(o?.users) ? o.users.filter(Boolean) : [],
    equipas: Array.isArray(o?.equipas) ? o.equipas.filter(Boolean) : [],
  };
}

// Lê SEMPRE do Storage (sem cache) — usado antes de gravar para não perder
// escritas concorrentes. Fail-open: erro → estado vazio (não bloqueia ninguém).
async function lerRaw() {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(CAMINHO);
    if (!data) return { ...VAZIO };
    return normalizar(JSON.parse(await data.text()));
  } catch {
    return { ...VAZIO };
  }
}

// Lê com cache (TTL). Usado pela gate de cada pedido.
async function ler() {
  const agora = Date.now();
  if (_cache && agora - _cacheAt < TTL_MS) return _cache;
  _cache = await lerRaw();
  _cacheAt = agora;
  return _cache;
}

async function gravar(obj) {
  const limpo = {
    users: [...new Set(normalizar(obj).users)],
    equipas: [...new Set(normalizar(obj).equipas)],
  };
  await supabase.storage
    .from(BUCKET)
    .upload(CAMINHO, Buffer.from(JSON.stringify(limpo)), { contentType: 'application/json', upsert: true });
  _cache = limpo; // atualiza já → efeito imediato
  _cacheAt = Date.now();
  return limpo;
}

async function definirUser(userId, suspenso) {
  const s = await lerRaw();
  const set = new Set(s.users);
  if (suspenso) set.add(userId); else set.delete(userId);
  await gravar({ users: [...set], equipas: s.equipas });
  return suspenso;
}

async function definirEquipa(teamId, suspensa) {
  const s = await lerRaw();
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
