// Futty v2.0 — Denúncias + triagem — camada de dados SEM DDL (Tijolo 3, Fase B).
// À boleia do padrão da casa (campeonatoStore): cada denúncia vive como um JSON no
// Storage (bucket privado "denuncias"), o LOG é append-only (eventos[] nunca se
// reescreve destrutivamente — só se acrescenta) = escudo jurídico. O dono é cego
// (só agregados). A tabela antiga `denuncias` (009) fica INTOCADA.
const crypto = require('crypto');
const { supabase } = require('./db');
const { comPrazo } = require('./comPrazo');

const BUCKET = 'denuncias';

const CATEGORIAS = ['nudez', 'violencia', 'assedio', 'spam', 'menor', 'outro'];
const LIMITE_DIA = 10; // anti-abuso: máx denúncias/dia (menor é imune)
const PESO_MIN = 0.2;

/** Garante o bucket privado (idempotente). Corre no arranque. */
async function ensureDenunciasBucket() {
  const { data: existe } = await supabase.storage.getBucket(BUCKET);
  if (existe) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist/i.test(error.message)) {
    console.error('[Futty] Falha ao criar bucket "denuncias":', error.message);
  }
}

const hoje = (agora) => new Date(agora).toISOString().slice(0, 10);

// ─── Peso do denunciante + limite diário (anti-abuso) ────────────────────────
function caminhoReporter(userId) {
  return `reporters/${userId}.json`;
}
// Rodada 8B: prazo de 3 s (comPrazo) em toda LEITURA do Storage deste módulo —
// uma ida sem resposta nunca pode prender quem chama (ex.: obterDesfechosDenuncias,
// no caminho de /api/inicio, embrulhado em seguro() do lado de lá).
async function obterReporter(userId) {
  const { data } = await comPrazo(supabase.storage.from(BUCKET).download(caminhoReporter(userId)), 3000, 'denuncias/reporter');
  if (!data) return { peso: 1, dia: null, contagem_dia: 0 };
  try { return JSON.parse(await data.text()); } catch { return { peso: 1, dia: null, contagem_dia: 0 }; }
}
async function guardarReporter(userId, meta) {
  await supabase.storage.from(BUCKET).upload(caminhoReporter(userId), Buffer.from(JSON.stringify(meta)),
    { contentType: 'application/json', upsert: true, cacheControl: '0' });
}
// Regista uma denúncia no contador diário. Devolve {ok, motivo?}.
async function registarQuota(userId, categoria, agoraISO) {
  const m = await obterReporter(userId);
  const d = hoje(agoraISO);
  if (m.dia !== d) { m.dia = d; m.contagem_dia = 0; }
  if (categoria !== 'menor' && m.contagem_dia >= LIMITE_DIA) {
    return { ok: false, motivo: 'Já recebemos as tuas denúncias de hoje.' };
  }
  m.contagem_dia += 1;
  await guardarReporter(userId, m);
  return { ok: true, peso: m.peso };
}
// Ajusta o peso conforme o desfecho (improcedente baixa, confirmada sobe).
async function ajustarPeso(userId, confirmada) {
  const m = await obterReporter(userId);
  m.peso = confirmada ? Math.min(1, (m.peso || 1) + 0.1) : Math.max(PESO_MIN, (m.peso || 1) * 0.8);
  await guardarReporter(userId, m);
  return m.peso;
}

// ─── Casos ───────────────────────────────────────────────────────────────────
// Ficheiro por equipa para a fila do admin; equipa null (ex. perfil) → "_sem".
function chaveEquipa(teamId) { return teamId || '_sem'; }
function caminhoCaso(teamId, id) { return `casos/${chaveEquipa(teamId)}/${id}.json`; }

// VELOCIDADE 6A (15-set): quem lê casos em rota quente (services/inicio.js,
// obterDesfechosDenuncias) guarda o resultado em cache por equipa. Gravar um
// caso tem de esquecer essa cache, senão o utilizador não via o desfecho da
// própria denúncia durante minutos. Registado por quem cacheia, chamado aqui.
const aoGravarCaso = [];
function aoGravar(fn) { aoGravarCaso.push(fn); }

async function guardarCaso(caso) {
  await supabase.storage.from(BUCKET).upload(caminhoCaso(caso.team_id, caso.id), Buffer.from(JSON.stringify(caso)),
    { contentType: 'application/json', upsert: true, cacheControl: '0' });
  for (const fn of aoGravarCaso) {
    try { fn(caso.team_id); } catch (e) { console.error('[denuncias] invalidação falhou:', e.message); }
  }
  return caso;
}
async function obterCaso(teamId, id) {
  const { data } = await comPrazo(supabase.storage.from(BUCKET).download(caminhoCaso(teamId, id)), 3000, 'denuncias/caso');
  if (!data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
async function listarEquipa(teamId) {
  const { data } = await comPrazo(supabase.storage.from(BUCKET).list(`casos/${chaveEquipa(teamId)}`, { limit: 500 }), 3000, 'denuncias/lista');
  const ids = (data || []).filter((f) => f.name.endsWith('.json')).map((f) => f.name.replace(/\.json$/, ''));
  const casos = await Promise.all(ids.map((id) => obterCaso(teamId, id)));
  return casos.filter(Boolean);
}
// Já existe uma denúncia deste denunciante sobre este alvo? (idempotência leve)
async function jaDenunciou(teamId, targetType, targetId, reporterId) {
  const casos = await listarEquipa(teamId);
  return casos.some((c) => c.target_type === targetType && c.target_id === targetId && c.reporter_id === reporterId);
}

// Cria o caso com o primeiro evento de log (append-only).
function novoCaso({ teamId, targetType, targetId, reporterId, categoria, descricao, pesoReporter, agoraISO }) {
  return {
    id: crypto.randomUUID(),
    team_id: teamId || null,
    target_type: targetType,
    target_id: targetId,
    reporter_id: reporterId,
    reporter_peso: pesoReporter ?? 1,
    categoria,
    descricao: (descricao || '').slice(0, 500) || null,
    estado: 'pendente', // pendente → ia_* / fila / escalada / resolvida
    prioritaria: categoria === 'menor',
    criado_em: agoraISO,
    resolvido_em: null,
    eventos: [{ quem: 'sistema', tipo: 'criada', quando: agoraISO, categoria }], // LOG append-only
  };
}
function logar(caso, evento) {
  caso.eventos.push(evento); // NUNCA se apaga/reescreve — só cresce
  return caso;
}

// ─── Agregados (o dono só vê isto — zero conteúdo, zero identidade) ───────────
async function agregados(teamIds) {
  const listas = await Promise.all((teamIds || []).map((t) => listarEquipa(t)));
  const casos = listas.flat();
  const porCategoria = {};
  let auto = 0; let humano = 0; let somaMs = 0; let resolvidos = 0;
  for (const c of casos) {
    porCategoria[c.categoria] = (porCategoria[c.categoria] || 0) + 1;
    if (c.estado === 'ia_removeu' || c.estado === 'ia_arquivou') auto += 1;
    if (c.estado === 'resolvida' || c.estado === 'escalada') humano += 1;
    if (c.resolvido_em) { somaMs += new Date(c.resolvido_em) - new Date(c.criado_em); resolvidos += 1; }
  }
  const total = casos.length;
  return {
    total,
    por_categoria: porCategoria,
    pct_auto_resolvida: total ? Math.round((auto / total) * 100) : 0,
    tempo_medio_ms: resolvidos ? Math.round(somaMs / resolvidos) : null,
    // ZERO conteúdo, zero reporter, zero alvo — só números (lei da SPEC-SEGURANCA v2).
  };
}

module.exports = {
  ensureDenunciasBucket, CATEGORIAS, LIMITE_DIA,
  registarQuota, ajustarPeso,
  guardarCaso, obterCaso, listarEquipa, jaDenunciou, novoCaso, logar, aoGravar,
  agregados,
};
