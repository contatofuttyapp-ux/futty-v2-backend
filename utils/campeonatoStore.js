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

// Os três formatos. "Todos contra todos + final" (pontos_final) joga a fase de grupos inteira e põe o 1º contra o 2º numa final;
// precisa de 3 times, porque com 2 a "fase de grupos" já seria a própria final.
const FORMATOS = ['pontos', 'mata', 'pontos_final'];
const MIN_TIMES_DO_FORMATO = { pontos: 2, mata: 2, pontos_final: 3 };

/** Formato desconhecido cai no padrão da casa (pontos corridos), como sempre foi. */
function lerFormato(valor) {
  return FORMATOS.includes(valor) ? valor : 'pontos';
}

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

// Prazo de 3 s (comPrazo) nas duas leituras — uma ida sem resposta
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

// Todos contra todos + final: os mesmos jogos dos pontos corridos (fase "grupos") e UMA vaga de final no fim, sem times até a
// fase de grupos acabar. Os confrontos antigos não têm `fase`: quem não diz nada é de grupos.
function gerarConfrontosPontosFinal(times) {
  const grupos = gerarConfrontosPontos(times).map((c) => ({ ...c, fase: 'grupos' }));
  const ultimaRonda = Math.max(...grupos.map((c) => c.ronda));
  const final = {
    id: crypto.randomUUID(), fase: 'final', ronda: ultimaRonda + 1, ordem: 0,
    time_a_id: null, time_b_id: null,
    placar_a: null, placar_b: null, jogado: false, vencedor_id: null, bye: false,
  };
  return [...grupos, final];
}

const faseDe = (c) => c.fase || 'grupos';
const confrontosDoGrupo = (camp) => (camp.confrontos || []).filter((c) => faseDe(c) === 'grupos');
const confrontoFinal = (camp) => (camp.confrontos || []).find((c) => c.fase === 'final') || null;

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

// Soma vitória 3, empate 1, derrota 0 sobre os confrontos dados, na ordem dos times.
function somarLinhas(camp, confrontos) {
  const linhas = camp.times.map((t) => ({
    id: t.id, nome: t.nome, kit: t.kit, cor: t.cor,
    J: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0, SG: 0, PTS: 0,
  }));
  const byId = Object.fromEntries(linhas.map((l) => [l.id, l]));
  for (const c of confrontos) {
    if (!c.jogado || c.placar_a == null || c.placar_b == null) continue;
    const A = byId[c.time_a_id]; const B = byId[c.time_b_id];
    if (!A || !B) continue;
    A.J += 1; B.J += 1; A.GP += c.placar_a; A.GC += c.placar_b; B.GP += c.placar_b; B.GC += c.placar_a;
    if (c.placar_a > c.placar_b) { A.V += 1; B.D += 1; A.PTS += 3; }
    else if (c.placar_b > c.placar_a) { B.V += 1; A.D += 1; B.PTS += 3; }
    else { A.E += 1; B.E += 1; A.PTS += 1; B.PTS += 1; }
  }
  linhas.forEach((l) => { l.SG = l.GP - l.GC; });
  return linhas;
}

// ─── Todos contra todos + final: tabela da fase de grupos ────────────────────
//
// Ordem: PTS → SG → GP → confronto direto. Se nem o confronto direto separa os times, a ordem NÃO sai do alfabeto nem do sorteio
// dos times: quem decide é o admin, e só quando o empate cruza a linha da final (2º × 3º). Empate mais abaixo (3º × 4º) fica
// empatado de verdade — os dois dividem o 3º lugar.

const chaveDoGrupo = (ids) => [...ids].sort().join('|');

// Confronto direto: a mini-tabela só com os jogos ENTRE os times do grupo (pontos, depois saldo, depois gols pró).
function miniTabela(ids, confrontos) {
  const dentro = new Set(ids);
  const m = Object.fromEntries(ids.map((id) => [id, { pts: 0, sg: 0, gp: 0 }]));
  for (const c of confrontos) {
    if (!c.jogado || c.placar_a == null || c.placar_b == null) continue;
    if (!dentro.has(c.time_a_id) || !dentro.has(c.time_b_id)) continue;
    const A = m[c.time_a_id]; const B = m[c.time_b_id];
    A.gp += c.placar_a; B.gp += c.placar_b;
    A.sg += c.placar_a - c.placar_b; B.sg += c.placar_b - c.placar_a;
    if (c.placar_a > c.placar_b) A.pts += 3;
    else if (c.placar_b > c.placar_a) B.pts += 3;
    else { A.pts += 1; B.pts += 1; }
  }
  return m;
}

const mesmoNumero = (a, b) => a.pts === b.pts && a.sg === b.sg && a.gp === b.gp;

// Ordena um grupo de times empatados em PTS/SG/GP. Devolve BLOCOS na ordem final: bloco de 1 time = posição decidida; bloco de
// 2+ = empate que ninguém desfez. O confronto direto é refeito a cada vez que o grupo encolhe (3 empatados que se separam em 1 + 2
// voltam a se olhar só entre os 2); depois dele, a escolha do admin para ESSE grupo exato.
function ordenarEmpatados(ids, ctx) {
  if (ids.length === 1) return [ids];
  const mini = miniTabela(ids, ctx.confrontos);
  const porMini = [...ids].sort((x, y) => mini[y].pts - mini[x].pts || mini[y].sg - mini[x].sg || mini[y].gp - mini[x].gp);
  const partes = [];
  porMini.forEach((id) => {
    const ultima = partes[partes.length - 1];
    if (ultima && mesmoNumero(mini[ultima[0]], mini[id])) ultima.push(id);
    else partes.push([id]);
  });
  if (partes.length > 1) return partes.flatMap((p) => ordenarEmpatados(p, ctx));
  const chave = chaveDoGrupo(ids);
  const escolha = ctx.escolhas.find((e) => e.grupo === chave && ids.includes(e.time_id));
  if (escolha) return [[escolha.time_id], ...ordenarEmpatados(ids.filter((id) => id !== escolha.time_id), ctx)];
  return [[...ids].sort((x, y) => ctx.ordem[x] - ctx.ordem[y])];
}

/**
 * A tabela da fase de grupos e o que falta para a final.
 * `linhas` ganham `pos` (posição; times ainda empatados dividem o número) e `empatado`. Enquanto a fase não acaba a tabela é só
 * provisória (posição = ordem da lista, sem empate declarado). `pendencia` existe quando, com a fase completa, um empate sem
 * solução cruza a linha da final: `vagas` = quantos dos `candidatos` entram na final.
 */
function tabelaDaFase1(camp) {
  const grupos = confrontosDoGrupo(camp);
  const completa = grupos.length > 0 && grupos.every((c) => c.jogado);
  const linhas = somarLinhas(camp, grupos);
  const ordem = Object.fromEntries(camp.times.map((t, i) => [t.id, i]));
  linhas.sort((x, y) => y.PTS - x.PTS || y.SG - x.SG || y.GP - x.GP); // estável: empatado mantém a ordem dos times
  if (!completa) {
    linhas.forEach((l, i) => { l.pos = i + 1; l.empatado = false; });
    return { linhas, completa, pendencia: null };
  }
  const ctx = { confrontos: grupos, escolhas: camp.desempates || [], ordem };
  const porId = Object.fromEntries(linhas.map((l) => [l.id, l]));
  const blocos = [];
  let corrida = [];
  const fecharCorrida = () => { if (corrida.length) blocos.push(...ordenarEmpatados(corrida.map((l) => l.id), ctx)); corrida = []; };
  linhas.forEach((l) => {
    const ultima = corrida[corrida.length - 1];
    if (ultima && (ultima.PTS !== l.PTS || ultima.SG !== l.SG || ultima.GP !== l.GP)) fecharCorrida();
    corrida.push(l);
  });
  fecharCorrida();
  const ordenadas = [];
  let pos = 1;
  let pendencia = null;
  blocos.forEach((bloco) => {
    if (!pendencia && bloco.length > 1 && pos <= 2 && pos + bloco.length - 1 >= 3) {
      pendencia = { tipo: 'empate_final', vagas: 3 - pos, candidatos: bloco.slice() };
    }
    bloco.forEach((id) => ordenadas.push({ ...porId[id], pos, empatado: bloco.length > 1 }));
    pos += bloco.length;
  });
  return { linhas: ordenadas, completa, pendencia };
}

function classificacao(camp) {
  if (camp.formato === 'pontos_final') return tabelaDaFase1(camp).linhas;
  const linhas = somarLinhas(camp, camp.confrontos);
  linhas.sort((x, y) => y.PTS - x.PTS || y.SG - x.SG || y.GP - x.GP || x.nome.localeCompare(y.nome));
  return linhas;
}

const MSG_FINAL_JOGADA = 'A final já foi jogada e o campeão está decidido: a fase de grupos não pode mais ser corrigida.';

/**
 * Põe 1º × 2º na final quando a fase de grupos acaba e a refaz quando uma correção muda quem são eles. O que mudou para o admin
 * saber vai em `avisos`. Com a final já jogada nada muda: lança MSG_FINAL_JOGADA (a rota barra isso antes de gravar).
 */
function sincronizarFinal(camp, avisos = []) {
  const final = confrontoFinal(camp);
  if (!final) return;
  const { linhas, completa, pendencia } = tabelaDaFase1(camp);
  if (!completa || pendencia) {
    if (final.time_a_id) {
      if (final.jogado) throw new Error(MSG_FINAL_JOGADA);
      final.time_a_id = null; final.time_b_id = null;
      avisos.push('A tabela mudou e agora há um empate na vaga da final. Decida o empate para a final voltar.');
    }
    return;
  }
  const a = linhas[0].id;
  const b = linhas[1].id;
  if (!final.time_a_id) { final.time_a_id = a; final.time_b_id = b; return; }
  if ([a, b].includes(final.time_a_id) && [a, b].includes(final.time_b_id)) return;
  if (final.jogado) throw new Error(MSG_FINAL_JOGADA);
  final.time_a_id = a; final.time_b_id = b;
  const nome = (id) => camp.times.find((t) => t.id === id)?.nome || '—';
  avisos.push(`A tabela mudou: a final agora é ${nome(a)} × ${nome(b)}.`);
}

/** O admin tocou num time do empate: ele passa na frente dos outros do mesmo grupo. */
function decidirEmpate(camp, timeId, avisos = []) {
  if (camp.formato !== 'pontos_final') throw new Error('Este campeonato não tem empate para decidir.');
  const { pendencia } = tabelaDaFase1(camp);
  if (!pendencia) throw new Error('Não há empate para decidir agora.');
  if (!pendencia.candidatos.includes(timeId)) throw new Error('Esse time não está no empate.');
  camp.desempates = [...(camp.desempates || []), { grupo: chaveDoGrupo(pendencia.candidatos), time_id: timeId }];
  sincronizarFinal(camp, avisos);
  return camp;
}

/** O campeonato como as telas o recebem: campeão resolvido e, nos formatos de tabela, a classificação já calculada. */
function enriquecer(camp) {
  const campeao = camp.campeao_time_id ? camp.times.find((t) => t.id === camp.campeao_time_id) || null : null;
  const out = { ...camp, campeao };
  if (camp.formato === 'pontos') out.classificacao = classificacao(camp);
  if (camp.formato === 'pontos_final') {
    const { linhas, completa, pendencia } = tabelaDaFase1(camp);
    const porId = Object.fromEntries(camp.times.map((t) => [t.id, t]));
    out.classificacao = linhas;
    out.fase1_completa = completa;
    out.pendencia = pendencia
      ? { tipo: pendencia.tipo, vagas: pendencia.vagas, candidatos: pendencia.candidatos.map((id) => ({ id, nome: porId[id].nome, cor: porId[id].cor })) }
      : null;
    delete out.desempates;
  }
  return out;
}

// Pódio 1º/2º/3º (para selos de honra). pontos: top-3 da tabela; mata: campeão /
// vice / melhor semifinalista (SG→GP→ordem). Devolve [{pos, tier, time}].
function podio(camp) {
  const tm = {};
  (camp.times || []).forEach((t) => { tm[t.id] = t; });
  const TIER = { 1: 'ouro', 2: 'prata', 3: 'bronze' };
  if (camp.formato === 'pontos_final') {
    // 1º = campeão da final, 2º = quem perdeu a final, 3º = o 3º da tabela da fase de grupos (se 2 times dividem o 3º lugar, os 2 sobem).
    const final = confrontoFinal(camp);
    if (!final || !final.jogado) return [];
    const champId = camp.campeao_time_id;
    const viceId = final.time_a_id === champId ? final.time_b_id : final.time_a_id;
    const terceiros = tabelaDaFase1(camp).linhas.filter((l) => l.pos === 3 && l.id !== champId && l.id !== viceId);
    return [
      { pos: 1, tier: TIER[1], time: tm[champId] },
      { pos: 2, tier: TIER[2], time: tm[viceId] },
      ...terceiros.map((l) => ({ pos: 3, tier: TIER[3], time: tm[l.id] })),
    ].filter((x) => x.time);
  }
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

// O campeonato novo, montado em memória (times, calendário, vaga da final). `criar` só acrescenta o gravar no Storage.
function montar(teamId, criadoPor, opts) {
  const { nome, formato } = opts;
  let times;
  let seed = null;
  if (opts.usar_sorteio) {
    seed = opts.seed || (Math.floor((mulberry32(Date.now() % 2 ** 31)()) * 2 ** 31));
    times = gerarTimesSorteio(opts.participantes || [], opts.num_times, seed, opts.nomes);
  } else {
    times = gerarTimesManual(opts.nomes || [], opts.plantel);
  }
  const formatoLido = lerFormato(formato);
  if (formatoLido === 'pontos_final' && times.length < MIN_TIMES_DO_FORMATO.pontos_final) {
    throw new Error('Este formato precisa de pelo menos 3 times.');
  }
  const confrontos = formatoLido === 'mata' ? gerarConfrontosMata(times)
    : formatoLido === 'pontos_final' ? gerarConfrontosPontosFinal(times) : gerarConfrontosPontos(times);
  const camp = {
    id: crypto.randomUUID(),
    team_id: teamId,
    nome: String(nome).slice(0, 60),
    formato: formatoLido,
    estado: 'em_curso',
    seed,
    criado_por: criadoPor,
    criado_em: new Date().toISOString(),
    times,
    confrontos,
    campeao_time_id: null,
  };
  // As escolhas do admin nos empates da tabela (ver decidirEmpate): só este formato tem empate para decidir.
  if (formatoLido === 'pontos_final') camp.desempates = [];
  return camp;
}

async function criar(teamId, criadoPor, opts) {
  return guardar(montar(teamId, criadoPor, opts));
}

// Aplica um resultado (só admin, validado na rota). Recalcula bracket/estado. `avisos` recebe o que o admin precisa saber
// (hoje: a final que foi refeita porque uma correção mudou quem são o 1º e o 2º).
function aplicarResultado(camp, confrontoId, pa, pb, avisos = []) {
  const c = camp.confrontos.find((x) => x.id === confrontoId);
  if (!c) throw new Error('Confronto não encontrado.');
  const ehFinal = camp.formato === 'pontos_final' && c.fase === 'final';
  if (!c.time_a_id || !c.time_b_id) {
    throw new Error(ehFinal ? 'A final só abre depois do último jogo da fase de grupos.' : 'Confronto ainda não tem os dois times.');
  }
  if (camp.formato === 'mata' && pa === pb) throw new Error('No mata-mata não há empate. Desempate no resultado.');
  // A final é como a do mata-mata: placar empatado não vale, o desempate (pênaltis) entra no próprio placar.
  if (ehFinal && pa === pb) throw new Error('Na final não há empate. Se foi para os pênaltis, lance o placar já com o desempate (ex.: 4 × 3).');
  c.placar_a = pa; c.placar_b = pb; c.jogado = true;
  c.vencedor_id = pa > pb ? c.time_a_id : pb > pa ? c.time_b_id : null;

  if (camp.formato === 'pontos_final') {
    if (ehFinal) {
      camp.campeao_time_id = c.vencedor_id;
      camp.estado = 'terminado';
      camp.terminado_em = new Date().toISOString();
    } else {
      sincronizarFinal(camp, avisos);
    }
  } else if (camp.formato === 'mata') {
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
  FORMATOS,
  MIN_TIMES_DO_FORMATO,
  MSG_FINAL_JOGADA,
  lerFormato,
  enriquecer,
  tabelaDaFase1,
  decidirEmpate,
  montar,
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
