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

// O id do campeonato chega do endereço (req.params.id, já decodificado: "..%2F" vira "../") e entra no caminho do Storage. Só um uuid de
// verdade vale, para um "../" nunca sair da pasta do time e alcançar o documento de outro.
const ID_DE_CAMPEONATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idValido = (id) => typeof id === 'string' && ID_DE_CAMPEONATO.test(id);

function caminho(teamId, id) {
  return `t/${teamId}/${id}.json`;
}

async function guardar(camp) {
  const body = Buffer.from(JSON.stringify(camp));
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(caminho(camp.team_id, camp.id), body, { contentType: 'application/json', upsert: true, cacheControl: '0' });
  if (error) throw new Error(error.message);
  esquecerCacheDoInicio(camp.team_id);
  return camp;
}

// Prazo de 3 s (comPrazo) nas duas leituras — uma ida sem resposta
// nunca pode prender quem chama (mesmo padrão de denunciaStore/gabineteStore/
// plataformaStore). Se o prazo vencer, rejeita como uma falha normal do Storage
// já rejeitaria — quem chama (asyncHandler das rotas) já sabe tratar isso.
async function obter(teamId, id) {
  if (!idValido(id)) return null;
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
  if (!idValido(id)) return;
  await supabase.storage.from(BUCKET).remove([caminho(teamId, id)]);
  esquecerCacheDoInicio(teamId);
}

// ─── Montagem dos times ──────────────────────────────────────────────────────

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

const VAGAS_NA_FINAL = 2;
const PONTOS_POR_VITORIA = 3;

// Quem já está GARANTIDO na final enquanto ainda há jogos por fazer. Conta só pontos e é prudente de propósito: cada rival ainda pode
// somar 3 pontos por jogo que lhe falta, e quem pode igualar os pontos de hoje conta como rival (o desempate seria incerto). Um time
// está garantido quando no máximo UM rival ainda consegue chegar aos pontos dele — então ele termina, no pior caso, em 2º.
function garantidosNaFinal(linhas, grupos) {
  const faltam = {};
  grupos.filter((c) => !c.jogado).forEach((c) => {
    faltam[c.time_a_id] = (faltam[c.time_a_id] || 0) + 1;
    faltam[c.time_b_id] = (faltam[c.time_b_id] || 0) + 1;
  });
  const maximo = (l) => l.PTS + PONTOS_POR_VITORIA * (faltam[l.id] || 0);
  return new Set(linhas
    .filter((l) => linhas.filter((x) => x.id !== l.id && maximo(x) >= l.PTS).length < VAGAS_NA_FINAL)
    .map((l) => l.id));
}

/**
 * A tabela da fase de grupos e o que falta para a final.
 * `linhas` ganham `pos` (posição; times ainda empatados dividem o número), `empatado` e `classificado` (garantido na final: durante a
 * fase só quem a matemática já põe lá; com a fase completa, os dois finalistas — e nunca só um de dois times empatados). Enquanto a fase
 * não acaba a tabela é só provisória (posição = ordem da lista, sem empate declarado). `pendencia` existe quando, com a fase completa,
 * um empate sem solução cruza a linha da final: `vagas` = quantos dos `candidatos` entram na final.
 */
function tabelaDaFase1(camp) {
  const grupos = confrontosDoGrupo(camp);
  const completa = grupos.length > 0 && grupos.every((c) => c.jogado);
  const linhas = somarLinhas(camp, grupos);
  const ordem = Object.fromEntries(camp.times.map((t, i) => [t.id, i]));
  linhas.sort((x, y) => y.PTS - x.PTS || y.SG - x.SG || y.GP - x.GP); // estável: empatado mantém a ordem dos times
  if (!completa) {
    const garantidos = garantidosNaFinal(linhas, grupos);
    linhas.forEach((l, i) => { l.pos = i + 1; l.empatado = false; l.classificado = garantidos.has(l.id); });
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
  // Fase completa: finalista é quem fica nas duas primeiras posições. Com um empate sem solução na linha da final, só entram já
  // os que estão ACIMA dos empatados (os empatados esperam a escolha do admin: marcar um dos dois seria escolher por ele).
  const inicioDoEmpate = pendencia ? Math.min(...ordenadas.filter((l) => pendencia.candidatos.includes(l.id)).map((l) => l.pos)) : Infinity;
  ordenadas.forEach((l) => { l.classificado = l.pos <= VAGAS_NA_FINAL && l.pos < inicioDoEmpate; });
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

/**
 * O próximo jogo: o primeiro ainda sem placar, na ordem da lista de jogos (rodada, depois a ordem dentro dela), com os dois times já
 * conhecidos — por isso a vaga da final, sem nomes, só entra quando a fase de grupos fecha. Some quando o campeonato termina.
 * `final` diz que é a decisão (a final, ou a última rodada do mata-mata).
 */
function proximoJogo(camp) {
  if (camp.estado === 'terminado') return null;
  const porId = Object.fromEntries((camp.times || []).map((t) => [t.id, t]));
  const ultimaRonda = Math.max(0, ...(camp.confrontos || []).map((c) => c.ronda));
  const proximo = [...(camp.confrontos || [])]
    .sort((x, y) => x.ronda - y.ronda || x.ordem - y.ordem)
    .find((c) => !c.bye && !c.jogado && porId[c.time_a_id] && porId[c.time_b_id]);
  if (!proximo) return null;
  const cartao = (t) => ({ nome: t.nome, cor: t.cor });
  const ehFinal = camp.formato === 'pontos_final' ? proximo.fase === 'final' : camp.formato === 'mata' && proximo.ronda === ultimaRonda;
  return { a: cartao(porId[proximo.time_a_id]), b: cartao(porId[proximo.time_b_id]), final: ehFinal };
}

/** O campeonato como as telas o recebem: campeão resolvido, o próximo jogo e, nos formatos de tabela, a classificação já calculada. */
function enriquecer(camp) {
  const campeao = camp.campeao_time_id ? camp.times.find((t) => t.id === camp.campeao_time_id) || null : null;
  const out = { ...camp, campeao, proximo_jogo: proximoJogo(camp) };
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
  const times = gerarTimesManual(opts.nomes || [], opts.plantel);
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
    seed: null, // só os campeonatos antigos, criados pelo "sortear direto" (que saiu), têm semente
    criado_por: criadoPor,
    criado_em: new Date().toISOString(),
    times,
    confrontos,
    campeao_time_id: null,
  };
  // As escolhas do admin nos empates da tabela (ver decidirEmpate): só este formato tem empate para decidir.
  if (formatoLido === 'pontos_final') camp.desempates = [];
  // De que sorteio nasceu (campeonato criado pelo resultado do sorteio de um jogo): a lista "Pelo sorteio de um jogo" não oferece
  // de novo um sorteio que já virou campeonato.
  if (opts.origem) {
    camp.origem_game_id = opts.origem.game_id;
    camp.origem_assinatura = opts.origem.assinatura;
    camp.origem_data = opts.origem.data || null; // a data do jogo: aparece como subtítulo do campeonato
  }
  return camp;
}

// ─── Campeonato a partir do sorteio de um jogo: quais jogos oferecer ──────────────────────────────────────────────────────

// Jogo sorteado há mais tempo que isto não é oferecido: o campeonato é do dia (ou da semana) do jogo.
const JOGO_RECENTE_DIAS = 14;
const MAX_TIMES_DO_CAMPEONATO = 8;
const MAX_JOGADORES_POR_TIME = 22;

const chaveDoJogador = (j) => (j && j.user_id ? String(j.user_id) : `c:${String((j && j.nome) || '').trim().toLowerCase()}`);

/** O "retrato" de um sorteio: quem está em cada time (a ordem dentro do time não conta, a ordem dos times sim). */
function assinaturaDosTimes(times) {
  return (times || []).slice(0, MAX_TIMES_DO_CAMPEONATO)
    .map((t) => (t.jogadores || []).slice(0, MAX_JOGADORES_POR_TIME).map(chaveDoJogador).sort().join(','))
    .join('|');
}

/** Este campeonato já nasceu deste sorteio? Os criados antes de gravar a origem são reconhecidos pelo elenco, que é copiado do sorteio. */
function campeonatoVemDoSorteio(camp, jogo) {
  const assinatura = assinaturaDosTimes(jogo.times_resultado?.times);
  if (camp.origem_game_id) return camp.origem_game_id === jogo.id && camp.origem_assinatura === assinatura;
  return assinaturaDosTimes(camp.times) === assinatura;
}

/**
 * Os jogos que a escolha "Pelo sorteio de um jogo" oferece: sorteio feito (ou times montados à mão) com 2+ times, jogo não cancelado,
 * de até JOGO_RECENTE_DIAS atrás em diante, e que ainda não virou campeonato. O mais recente primeiro.
 */
function jogosElegiveisParaCampeonato(jogos, campeonatos, agora = Date.now()) {
  const limite = agora - JOGO_RECENTE_DIAS * 86400000;
  return (jogos || [])
    .filter((g) => g.sorteio_realizado && (g.times_resultado?.times || []).length >= 2)
    .filter((g) => !g.cancelado && g.status !== 'cancelado')
    .filter((g) => g.data && new Date(g.data).getTime() >= limite)
    .filter((g) => !(campeonatos || []).some((c) => campeonatoVemDoSorteio(c, g)))
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
}

async function criar(teamId, criadoPor, opts) {
  return guardar(montar(teamId, criadoPor, opts));
}

// ─── O campeonato no Início de quem é do time ──────────────────────────────────────────────────────────────────────────────

// O campeão fica no Início de todo o time por uma semana.
const DIAS_DO_CAMPEAO_NO_INICIO = 7;

// Os jogos que contam no "X de N jogos": os de verdade (sem bye) e, em "todos contra todos + final", só os da fase de grupos.
const jogosReais = (camp) => (camp.confrontos || []).filter((c) => !c.bye && (camp.formato !== 'pontos_final' || faseDe(c) === 'grupos'));

const nomeDaRodada = (tamanho) => ({ 2: 'Final', 4: 'Semifinais', 8: 'Quartas', 16: 'Oitavas' }[tamanho] || 'Fase');

/** Em que fase o campeonato está agora, no nome que a tela usa. */
function faseDoCampeonato(camp) {
  if (camp.estado === 'terminado') return 'Terminado';
  if (camp.formato === 'pontos_final') {
    const final = confrontoFinal(camp);
    return final && final.time_a_id ? 'Final' : 'Fase de grupos';
  }
  if (camp.formato === 'pontos') return 'Pontos corridos';
  const porRonda = {};
  camp.confrontos.forEach((c) => { (porRonda[c.ronda] ||= []).push(c); });
  const aberta = Object.keys(porRonda).map(Number).sort((x, y) => x - y).find((r) => porRonda[r].some((c) => !c.jogado));
  return nomeDaRodada((porRonda[aberta]?.length || 1) * 2);
}

/**
 * O que o card do Início mostra de um campeonato: a fase, quantos jogos já foram lançados, os 2 primeiros da tabela (só depois do
 * 1º jogo: com a tabela zerada o "1º" seria só o primeiro da lista), a final quando está definida e o campeão — com `voce_e_campeao`
 * para quem é do time campeão.
 */
function resumoParaInicio(camp, userId) {
  const jogos = jogosReais(camp);
  const lancados = jogos.filter((c) => c.jogado).length;
  const porId = Object.fromEntries(camp.times.map((t) => [t.id, t]));
  const cartao = (t) => (t ? { nome: t.nome, cor: t.cor } : null);
  const out = {
    id: camp.id, nome: camp.nome, formato: camp.formato, estado: camp.estado, fase: faseDoCampeonato(camp),
    jogos_lancados: lancados, jogos_total: jogos.length, primeiros: [], final: null, proximo: proximoJogo(camp), campeao: null, voce_e_campeao: false,
    terminado_em: camp.terminado_em || null, origem_data: camp.origem_data || null,
  };
  if ((camp.formato === 'pontos' || camp.formato === 'pontos_final') && lancados > 0) {
    out.primeiros = classificacao(camp).slice(0, 2).map((l, i) => ({ nome: l.nome, cor: l.cor, PTS: l.PTS, pos: l.pos ?? i + 1 }));
  }
  const final = camp.formato === 'pontos_final' ? confrontoFinal(camp) : null;
  if (final && final.time_a_id && !final.jogado) out.final = { a: cartao(porId[final.time_a_id]), b: cartao(porId[final.time_b_id]) };
  const campeao = camp.campeao_time_id ? porId[camp.campeao_time_id] : null;
  if (campeao) {
    out.campeao = cartao(campeao);
    out.voce_e_campeao = !!userId && (campeao.jogadores || []).some((j) => j.user_id && String(j.user_id) === String(userId));
  }
  return out;
}

/** Qual campeonato o Início mostra: o que está em andamento (o mais novo) ou, se não há, o que terminou há menos de uma semana. */
function resumoDoInicio(campeonatos, userId, agora = Date.now()) {
  const emCurso = (campeonatos || []).filter((c) => c.estado !== 'terminado').sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')))[0];
  if (emCurso) return resumoParaInicio(emCurso, userId);
  const limite = agora - DIAS_DO_CAMPEAO_NO_INICIO * 86400000;
  const recente = (campeonatos || [])
    .filter((c) => c.estado === 'terminado' && c.terminado_em && Date.parse(c.terminado_em) >= limite)
    .sort((a, b) => String(b.terminado_em).localeCompare(String(a.terminado_em)))[0];
  return recente ? resumoParaInicio(recente, userId) : null;
}

// O Início é a tela mais pedida do app: ler os campeonatos do Storage a cada pedido seria pesado. Fica guardado 30 s por time, e
// qualquer gravação (guardar/apagar) o esquece na hora. Só os 3 documentos mexidos mais recentemente são lidos.
const CACHE_DO_INICIO_MS = 30000;
const cacheDoInicio = new Map();
const esquecerCacheDoInicio = (teamId) => { cacheDoInicio.delete(teamId); };

async function campeonatosRecentes(teamId, max = 3) {
  const guardado = cacheDoInicio.get(teamId);
  if (guardado && Date.now() - guardado.em < CACHE_DO_INICIO_MS) return guardado.camps;
  const { data } = await comPrazo(supabase.storage.from(BUCKET).list(`t/${teamId}`, { limit: 200 }), 3000, 'campeonatos/recentes');
  const quando = (f) => String(f.updated_at || f.created_at || '');
  const arquivos = (data || []).filter((f) => f.name.endsWith('.json')).sort((a, b) => quando(b).localeCompare(quando(a))).slice(0, max);
  const camps = (await Promise.all(arquivos.map((f) => obter(teamId, f.name.replace(/\.json$/, ''))))).filter(Boolean);
  cacheDoInicio.set(teamId, { em: Date.now(), camps });
  return camps;
}

// ─── O post do campeão na Resenha ────────────────────────────────────────────────────────────────────────────────────────

/**
 * O que o post do campeão do campeonato guarda: o time campeão com os jogadores, o pódio e o placar da final (com o vencedor dos
 * pênaltis, se houve). Vai em `feed_posts.conteudo` (jsonb que já existe) com `conteudo.tipo = 'campeao_campeonato'`; o `tipo` da
 * linha fica 'post' (o CHECK da coluna só aceita post, anuncio, jogo e voto).
 */
function conteudoDoPostDoCampeao(camp) {
  const porId = Object.fromEntries(camp.times.map((t) => [t.id, t]));
  const campeao = porId[camp.campeao_time_id];
  if (!campeao) return null;
  const f = confrontoDaFinal(camp);
  const final = f && f.jogado ? {
    a: { nome: porId[f.time_a_id]?.nome || '—', gols: f.placar_a },
    b: { nome: porId[f.time_b_id]?.nome || '—', gols: f.placar_b },
    penaltis: f.penaltis_vencedor_id ? porId[f.penaltis_vencedor_id]?.nome || null : null,
  } : null;
  const conteudo = {
    tipo: 'campeao_campeonato', campeonato_id: camp.id, campeonato_nome: camp.nome, formato: camp.formato,
    campeao: {
      nome: campeao.nome, cor: campeao.cor,
      jogadores: (campeao.jogadores || []).map((j) => ({ user_id: j.user_id || null, nome: j.nome, avatar_url: j.avatar_url || null, convidado: !!j.convidado })),
    },
    podio: podio(camp).map((p) => ({ pos: p.pos, nome: p.time.nome, cor: p.time.cor })),
    final,
  };
  // "<Time> é campeão · <campeonato>": sem preposição, para o nome do campeonato ("Copa…", "Taça…", "Liga…") nunca errar o gênero.
  return { body: `🏆 ${campeao.nome} é campeão · ${camp.nome}`.slice(0, 2000), conteudo };
}

// Aplica um resultado (só admin, validado na rota). Recalcula bracket/estado. `avisos` recebe o que o admin precisa saber
// (hoje: a final que foi refeita porque uma correção mudou quem são o 1º e o 2º).
// O último jogo do campeonato: a final de "todos contra todos + final" ou o confronto da última rodada do mata-mata. Pontos
// corridos não tem final (o líder da tabela é o campeão).
function confrontoDaFinal(camp) {
  if (camp.formato === 'pontos_final') return confrontoFinal(camp);
  if (camp.formato === 'mata') {
    const ultima = Math.max(...camp.confrontos.map((x) => x.ronda));
    return camp.confrontos.find((x) => x.ronda === ultima) || null;
  }
  return null;
}

// Placar empatado não decide jogo eliminatório (a final e o mata-mata): o placar fica como foi digitado e quem passou/levantou a
// taça é o vencedor dos pênaltis.
const ehEliminatoria = (camp, c) => camp.formato === 'mata' || (camp.formato === 'pontos_final' && c.fase === 'final');

// `penaltisVencedorId` só vale (e só é exigido) quando o placar de um jogo eliminatório empata. Depois do campeão só a FINAL pode
// ser corrigida (um placar digitado errado na decisão não pode ficar para sempre); os jogos de antes mexeriam em quem chegou lá.
function aplicarResultado(camp, confrontoId, pa, pb, avisos = [], penaltisVencedorId = null) {
  const c = camp.confrontos.find((x) => x.id === confrontoId);
  if (!c) throw new Error('Confronto não encontrado.');
  const final = confrontoDaFinal(camp);
  const ehFinal = !!final && final.id === c.id;
  if (camp.estado === 'terminado' && !ehFinal) throw new Error(camp.formato === 'pontos_final' ? MSG_FINAL_JOGADA : 'Campeonato já terminou.');
  if (!c.time_a_id || !c.time_b_id) {
    throw new Error(ehFinal && camp.formato === 'pontos_final' ? 'A final só abre depois do último jogo da fase de grupos.' : 'Confronto ainda não tem os dois times.');
  }
  let penaltis = null;
  if (pa === pb && ehEliminatoria(camp, c)) {
    if (penaltisVencedorId !== c.time_a_id && penaltisVencedorId !== c.time_b_id) throw new Error('Empatou: diga quem venceu nos pênaltis.');
    penaltis = penaltisVencedorId;
  }
  c.placar_a = pa; c.placar_b = pb; c.jogado = true;
  c.penaltis_vencedor_id = penaltis;
  c.vencedor_id = penaltis || (pa > pb ? c.time_a_id : pb > pa ? c.time_b_id : null);
  const agora = new Date().toISOString();

  if (camp.formato === 'pontos_final') {
    if (ehFinal) {
      camp.campeao_time_id = c.vencedor_id;
      camp.estado = 'terminado';
      camp.terminado_em = camp.terminado_em || agora; // corrigir a final não renova os 30 dias dos selos
    } else {
      sincronizarFinal(camp, avisos);
    }
  } else if (camp.formato === 'mata') {
    colocarVencedor(camp.confrontos, c);
    if (final.jogado && final.vencedor_id) {
      camp.campeao_time_id = final.vencedor_id;
      camp.estado = 'terminado';
      camp.terminado_em = camp.terminado_em || agora;
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
  assinaturaDosTimes,
  campeonatoVemDoSorteio,
  jogosElegiveisParaCampeonato,
  JOGO_RECENTE_DIAS,
  enriquecer,
  tabelaDaFase1,
  confrontoDaFinal,
  proximoJogo,
  resumoParaInicio,
  resumoDoInicio,
  campeonatosRecentes,
  esquecerCacheDoInicio,
  conteudoDoPostDoCampeao,
  DIAS_DO_CAMPEAO_NO_INICIO,
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
