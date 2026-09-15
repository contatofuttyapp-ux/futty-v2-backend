// Futty v2.0 — Campeonato (N times) — camada de dados SEM DDL.
// O ambiente não permite criar tabelas (só PostgREST + Storage + Auth admin),
// por isso — à boleia do padrão VAGA 9/10 ("DDL nenhum") — cada campeonato vive
// como um documento JSON no Storage (bucket privado "campeonatos"), lido/escrito
// pelo backend com a service key. A tabela antiga `campeonatos` (026, 2 times
// fixos) fica INTOCADA. A migração 039 (tabelas reais) fica escrita como alvo
// futuro, não aplicada.
//
// RANKING DA EQUIPA INTOCADO: este módulo NUNCA escreve em votes/ratings/
// team_members — o campeonato é auto-contido no seu JSON.
const crypto = require('crypto');
const { supabase } = require('./db');
const { mulberry32, fisherYates } = require('./sorteio');
const { comPrazo } = require('./comPrazo');

const BUCKET = 'campeonatos';

// Kits da casa (mesma paleta do sorteio/mockup). Índice = ordem do time.
const KITS = [
  { kit: 'ouro', cor: '#d4a017' },
  { kit: 'roxo', cor: '#8b5cf6' },
  { kit: 'prata', cor: '#aab4c8' },
  { kit: 'bronze', cor: '#c2652e' },
  { kit: 'ciano', cor: '#35b6a8' },
  { kit: 'rosa', cor: '#d1689e' },
  { kit: 'verde', cor: '#6fae52' },
  { kit: 'ambar', cor: '#e08a2e' },
];

/** Garante o bucket privado "campeonatos" (idempotente). Corre no arranque. */
async function ensureCampeonatosBucket() {
  const { data: existe } = await supabase.storage.getBucket(BUCKET);
  if (existe) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist/i.test(error.message)) {
    console.error('[Futty] Falha ao criar bucket "campeonatos":', error.message);
  }
}

function caminho(teamId, id) {
  return `t/${teamId}/${id}.json`;
}

async function guardar(camp) {
  const body = Buffer.from(JSON.stringify(camp));
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(caminho(camp.team_id, camp.id), body, { contentType: 'application/json', upsert: true, cacheControl: '0' });
  if (error) throw new Error(error.message);
  return camp;
}

// Rodada 8B: prazo de 3 s (comPrazo) nas duas leituras — uma ida sem resposta
// nunca pode prender quem chama (mesmo padrão de denunciaStore/gabineteStore/
// plataformaStore). Se o prazo vencer, rejeita como uma falha normal do Storage
// já rejeitaria — quem chama (asyncHandler das rotas) já sabe tratar isso.
async function obter(teamId, id) {
  const { data, error } = await comPrazo(supabase.storage.from(BUCKET).download(caminho(teamId, id)), 3000, 'campeonatos/obter');
  if (error || !data) return null;
  const txt = await data.text();
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function listar(teamId) {
  const { data } = await comPrazo(supabase.storage.from(BUCKET).list(`t/${teamId}`, { limit: 200 }), 3000, 'campeonatos/listar');
  const ficheiros = (data || []).filter((f) => f.name.endsWith('.json'));
  const camps = await Promise.all(ficheiros.map((f) => obter(teamId, f.name.replace(/\.json$/, ''))));
  return camps
    .filter(Boolean)
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
}

async function apagar(teamId, id) {
  await supabase.storage.from(BUCKET).remove([caminho(teamId, id)]);
}

// ─── Montagem dos times ──────────────────────────────────────────────────────

// Sorteio: distribui membros + convidados por N times (snake sobre baralho
// semeado). Reutiliza o RNG do sorteio de jogo — a MESMA semente reproduz.
function gerarTimesSorteio(participantes, numTimes, seed, nomes) {
  const rng = mulberry32(seed);
  const baralho = fisherYates([...participantes], rng);
  const times = Array.from({ length: numTimes }, (_, i) => ({
    id: crypto.randomUUID(),
    nome: (nomes && nomes[i]) || `Time ${i + 1}`,
    kit: KITS[i % KITS.length].kit,
    cor: KITS[i % KITS.length].cor,
    jogadores: [],
  }));
  // snake: 0..N-1, N-1..0, ...
  let dir = 1;
  let t = 0;
  for (const p of baralho) {
    times[t].jogadores.push(p);
    if (dir === 1) {
      if (t === numTimes - 1) dir = -1;
      else t += 1;
    } else if (t === 0) dir = 1;
    else t -= 1;
  }
  return times;
}

// Manual: o admin dá os nomes; kit por índice; plantel opcional (pode vir vazio).
function gerarTimesManual(nomes, plantelPorTime) {
  return nomes.map((nome, i) => ({
    id: crypto.randomUUID(),
    nome: nome || `Time ${i + 1}`,
    kit: KITS[i % KITS.length].kit,
    cor: KITS[i % KITS.length].cor,
    jogadores: (plantelPorTime && plantelPorTime[i]) || [],
  }));
}

// ─── Calendário ──────────────────────────────────────────────────────────────

// Pontos corridos: todos-contra-todos (uma volta), agendado pelo método do
// círculo → jornadas equilibradas. Cada par vira 1 confronto por jogar.
function gerarConfrontosPontos(times) {
  const n = times.length;
  const ids = times.map((t) => t.id);
  const lista = n % 2 ? [...ids, null] : [...ids]; // bye p/ ímpar
  const m = lista.length;
  const rondas = m - 1;
  const confrontos = [];
  const arr = [...lista];
  for (let r = 0; r < rondas; r += 1) {
    for (let i = 0; i < m / 2; i += 1) {
      const a = arr[i];
      const b = arr[m - 1 - i];
      if (a && b) {
        confrontos.push({
          id: crypto.randomUUID(), ronda: r + 1, ordem: i,
          time_a_id: a, time_b_id: b,
          placar_a: null, placar_b: null, jogado: false, vencedor_id: null, bye: false,
        });
      }
    }
    // roda mantendo o primeiro fixo
    arr.splice(1, 0, arr.pop());
  }
  return confrontos;
}

// Ordem de seeds para um bracket de tamanho S (potência de 2).
function ordemSeeds(S) {
  let pls = [1, 2];
  while (pls.length < S) {
    const soma = pls.length * 2 + 1;
    const out = [];
    for (const p of pls) {
      out.push(p);
      out.push(soma - p);
    }
    pls = out;
  }
  return pls; // 1-indexed
}

// Mata-mata: bracket de tamanho = próxima potência de 2; byes p/ cabeças-de-chave.
// Gera TODAS as rondas (as futuras com slots a definir) e resolve os byes.
function gerarConfrontosMata(times) {
  const n = times.length;
  const S = 2 ** Math.ceil(Math.log2(n));
  const seeds = ordemSeeds(S); // slot -> seed(1..S)
  const slotTeam = seeds.map((s) => (s <= n ? times[s - 1].id : null)); // null = bye
  const totalRondas = Math.log2(S);
  const confrontos = [];
  // ronda 1
  for (let i = 0; i < S / 2; i += 1) {
    const a = slotTeam[i * 2];
    const b = slotTeam[i * 2 + 1];
    const c = {
      id: crypto.randomUUID(), ronda: 1, ordem: i,
      time_a_id: a, time_b_id: b,
      placar_a: null, placar_b: null, jogado: false, vencedor_id: null, bye: false,
    };
    if (a && !b) { c.bye = true; c.jogado = true; c.vencedor_id = a; }
    else if (b && !a) { c.bye = true; c.jogado = true; c.vencedor_id = b; }
    confrontos.push(c);
  }
  // rondas seguintes (vazias)
  for (let r = 2; r <= totalRondas; r += 1) {
    const num = S / 2 ** r;
    for (let i = 0; i < num; i += 1) {
      confrontos.push({
        id: crypto.randomUUID(), ronda: r, ordem: i,
        time_a_id: null, time_b_id: null,
        placar_a: null, placar_b: null, jogado: false, vencedor_id: null, bye: false,
      });
    }
  }
  // propaga byes p/ a ronda seguinte
  confrontos
    .filter((c) => c.ronda === 1 && c.jogado)
    .forEach((c) => colocarVencedor(confrontos, c));
  return confrontos;
}

function pai(confrontos, c) {
  return confrontos.find((p) => p.ronda === c.ronda + 1 && p.ordem === Math.floor(c.ordem / 2));
}

function colocarVencedor(confrontos, c) {
  const p = pai(confrontos, c);
  if (!p || !c.vencedor_id) return;
  if (c.ordem % 2 === 0) p.time_a_id = c.vencedor_id;
  else p.time_b_id = c.vencedor_id;
}

// ─── Classificação (pontos) ──────────────────────────────────────────────────
function classificacao(camp) {
  const linhas = camp.times.map((t) => ({
    id: t.id, nome: t.nome, kit: t.kit, cor: t.cor,
    J: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0, SG: 0, PTS: 0,
  }));
  const byId = Object.fromEntries(linhas.map((l) => [l.id, l]));
  for (const c of camp.confrontos) {
    if (!c.jogado || c.placar_a == null || c.placar_b == null) continue;
    const A = byId[c.time_a_id]; const B = byId[c.time_b_id];
    if (!A || !B) continue;
    A.J += 1; B.J += 1; A.GP += c.placar_a; A.GC += c.placar_b; B.GP += c.placar_b; B.GC += c.placar_a;
    if (c.placar_a > c.placar_b) { A.V += 1; B.D += 1; A.PTS += 3; }
    else if (c.placar_b > c.placar_a) { B.V += 1; A.D += 1; B.PTS += 3; }
    else { A.E += 1; B.E += 1; A.PTS += 1; B.PTS += 1; }
  }
  linhas.forEach((l) => { l.SG = l.GP - l.GC; });
  linhas.sort((x, y) => y.PTS - x.PTS || y.SG - x.SG || y.GP - x.GP || x.nome.localeCompare(y.nome));
  return linhas;
}

// Pódio 1º/2º/3º (para selos de honra). pontos: top-3 da tabela; mata: campeão /
// vice / melhor semifinalista (SG→GP→ordem). Devolve [{pos, tier, time}].
function podio(camp) {
  const tm = {};
  (camp.times || []).forEach((t) => { tm[t.id] = t; });
  const TIER = { 1: 'ouro', 2: 'prata', 3: 'bronze' };
  if (camp.formato === 'pontos') {
    const cl = classificacao(camp);
    return [cl[0], cl[1], cl[2]].map((l, i) => (l ? { pos: i + 1, tier: TIER[i + 1], time: tm[l.id] } : null)).filter((x) => x && x.time);
  }
  const confs = camp.confrontos || [];
  if (!confs.length) return [];
  const maxR = Math.max(...confs.map((c) => c.ronda));
  const final = confs.find((c) => c.ronda === maxR);
  const champId = camp.campeao_time_id;
  const viceId = final ? (final.time_a_id === champId ? final.time_b_id : final.time_a_id) : null;
  const semis = confs.filter((c) => c.ronda === maxR - 1 && c.jogado && c.time_a_id && c.time_b_id);
  const perdedores = semis.map((c) => (c.vencedor_id === c.time_a_id ? c.time_b_id : c.time_a_id));
  const stat = {};
  const add = (id, gp, gc) => { if (!id) return; stat[id] = stat[id] || { gp: 0, gc: 0 }; stat[id].gp += gp; stat[id].gc += gc; };
  confs.forEach((c) => { if (c.jogado && c.placar_a != null && c.placar_b != null) { add(c.time_a_id, c.placar_a, c.placar_b); add(c.time_b_id, c.placar_b, c.placar_a); } });
  const idx = (id) => camp.times.findIndex((t) => t.id === id);
  const sg = (id) => { const s = stat[id] || { gp: 0, gc: 0 }; return s.gp - s.gc; };
  const gp = (id) => (stat[id] || { gp: 0 }).gp;
  const terceiroId = perdedores.slice().sort((x, y) => (sg(y) - sg(x)) || (gp(y) - gp(x)) || (idx(x) - idx(y)))[0];
  return [
    champId ? { pos: 1, tier: 'ouro', time: tm[champId] } : null,
    viceId ? { pos: 2, tier: 'prata', time: tm[viceId] } : null,
    terceiroId ? { pos: 3, tier: 'bronze', time: tm[terceiroId] } : null,
  ].filter((x) => x && x.time);
}

// ─── Ações ───────────────────────────────────────────────────────────────────

async function criar(teamId, criadoPor, opts) {
  const { nome, formato } = opts;
  let times;
  let seed = null;
  if (opts.usar_sorteio) {
    seed = opts.seed || (Math.floor((mulberry32(Date.now() % 2 ** 31)()) * 2 ** 31));
    times = gerarTimesSorteio(opts.participantes || [], opts.num_times, seed, opts.nomes);
  } else {
    times = gerarTimesManual(opts.nomes || [], opts.plantel);
  }
  const confrontos = formato === 'mata' ? gerarConfrontosMata(times) : gerarConfrontosPontos(times);
  const camp = {
    id: crypto.randomUUID(),
    team_id: teamId,
    nome: String(nome).slice(0, 60),
    formato: formato === 'mata' ? 'mata' : 'pontos',
    estado: 'em_curso',
    seed,
    criado_por: criadoPor,
    criado_em: new Date().toISOString(),
    times,
    confrontos,
    campeao_time_id: null,
  };
  return guardar(camp);
}

// Aplica um resultado (só admin, validado na rota). Recalcula bracket/estado.
function aplicarResultado(camp, confrontoId, pa, pb) {
  const c = camp.confrontos.find((x) => x.id === confrontoId);
  if (!c) throw new Error('Confronto não encontrado.');
  if (!c.time_a_id || !c.time_b_id) throw new Error('Confronto ainda não tem os dois times.');
  if (camp.formato === 'mata' && pa === pb) throw new Error('No mata-mata não há empate — desempata no resultado.');
  c.placar_a = pa; c.placar_b = pb; c.jogado = true;
  c.vencedor_id = pa > pb ? c.time_a_id : pb > pa ? c.time_b_id : null;

  if (camp.formato === 'mata') {
    colocarVencedor(camp.confrontos, c);
    const ultima = Math.max(...camp.confrontos.map((x) => x.ronda));
    const final = camp.confrontos.find((x) => x.ronda === ultima);
    if (final.jogado && final.vencedor_id) {
      camp.campeao_time_id = final.vencedor_id;
      camp.estado = 'terminado';
      camp.terminado_em = new Date().toISOString();
    }
  } else {
    // pontos: se todos jogados, termina e coroa o líder
    const todos = camp.confrontos.every((x) => x.jogado);
    if (todos) {
      camp.estado = 'terminado';
      camp.campeao_time_id = classificacao(camp)[0]?.id || null;
      camp.terminado_em = new Date().toISOString();
    }
  }
  return camp;
}

function terminarPontos(camp) {
  camp.estado = 'terminado';
  camp.campeao_time_id = classificacao(camp)[0]?.id || null;
  camp.terminado_em = new Date().toISOString();
  return camp;
}

module.exports = {
  ensureCampeonatosBucket,
  KITS,
  criar,
  obter,
  listar,
  apagar,
  guardar,
  aplicarResultado,
  terminarPontos,
  classificacao,
  podio,
};
