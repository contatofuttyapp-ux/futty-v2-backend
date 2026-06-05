// Futty v2.0 — Migração de dados V1 (LowDB/JSON) → V2 (Supabase).
//
// ÂMBITO ATUAL (decisão do Pedro): "só perfis agora".
//   1. Perfis dos jogadores (nome_jogador, cor_preferida, avatar_url)
//   2. Equipa "Domingueira" + membros (os dois Pedro = admin)
//   Jogos / confirmações / votos ficam para uma FASE 2 (ver fim do ficheiro).
//
// CRUZAMENTO: por NOME (os emails V1 não correspondem aos @futtymock.com da V2).
//
// Uso:
//   node backend/scripts/migrar-v1.js --dry-run   (não escreve; só mostra o plano)
//   node backend/scripts/migrar-v1.js             (aplica na BD V2)
//
// Idempotente: pode correr várias vezes sem duplicar.
// Pré-requisito: correr a migração 012 no Supabase (nome_jogador/cor_preferida).

const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/db');

// ─── Configuração ──────────────────────────────────────────────────────────────
const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

// Caminho do db.json da V1 (LowDB). O ficheiro real está em data/db.json.
const V1_DB_CANDIDATOS = [
  'C:\\Users\\phfer\\Desktop\\FUT\\FUTTY\\backend\\data\\db.json',
  'C:\\Users\\phfer\\Desktop\\FUT\\FUTTY\\backend\\db.json',
];

// Sem base absoluta: guarda-se o caminho relativo do avatar (ex.:
// /public/avatares/verde/gui.png), que o backend V2 servirá quando os assets
// forem copiados. Quando houver Storage, troca-se por URLs do Supabase.
const V1_BACKEND_URL = null;

// Equipa a criar/usar.
const EQUIPA = { nome: 'Domingueira', slug: 'domingueira', cor: 'verde' };

// Os dois utilizadores Pedro Borges → admin da Domingueira.
const ADMIN_EMAILS = ['contatofuttyapp@gmail.com', 'phferreiraborgesbackup@gmail.com'];
// Quem fica como criador da equipa (criado_por). Sessão atual do Pedro.
const CRIADOR_EMAIL = 'phferreiraborgesbackup@gmail.com';

// Override para nomes ambíguos: email do user V2 → id do jogador V1.
// A V1 tem 4 "Matheus" (Motta 37, Menor 49, Zanardini 18, MT 10 41).
// Escolhido: Matheus Zanardini (18) — o único com avatar próprio. EDITÁVEL.
const OVERRIDES = {
  'matheus@futtymock.com': 18,
};

// ─── Logging ────────────────────────────────────────────────────────────────────
const stats = { perfis: 0, perfisInalterados: 0, membros: 0, ignorados: 0, erros: 0 };
const ok = (m) => console.log(`✅ ${m}`);
const skip = (m) => console.log(`⚠️  ${m}`);
const err = (m) => console.log(`❌ ${m}`);
const info = (m) => console.log(`ℹ️  ${m}`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Primeiro nome normalizado (sem acentos, minúsculas).
function primeiroNome(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || '';
}

function lerV1() {
  const p = V1_DB_CANDIDATOS.find((c) => fs.existsSync(c));
  if (!p) throw new Error(`db.json da V1 não encontrado em: ${V1_DB_CANDIDATOS.join(' | ')}`);
  info(`A ler V1 de: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// avatar_url V1 → URL absoluta no backend V1 (ou null se não houver foto própria).
function avatarUrlDe(jog) {
  const rel = String(jog?.avatar_verde_exibir || jog?.avatar_verde_path || '').trim();
  // Ignora genéricos (não são foto própria do jogador).
  if (!rel || rel.includes('/genericos/')) return null;
  // Caminho relativo directo (servido pelo backend V2 quando houver assets).
  return rel.startsWith('/') ? rel : `/${rel}`;
}

// ─── 1. Perfis (jogadores V1 → users V2, por nome) ──────────────────────────────
async function migrarPerfis(v1, usersV2) {
  console.log('\n── 1. PERFIS ───────────────────────────────────────────────');

  // Índice: primeiro nome → [jogadores V1]
  const porNome = new Map();
  for (const j of v1.jogadores || []) {
    const k = primeiroNome(j.nome_jogador || j.nome);
    if (!k) continue;
    if (!porNome.has(k)) porNome.set(k, []);
    porNome.get(k).push(j);
  }

  // Para cada user V2, tenta encontrar o jogador V1 correspondente.
  for (const u of usersV2) {
    const override = OVERRIDES[u.email];
    let jog = null;

    if (override != null) {
      jog = (v1.jogadores || []).find((j) => Number(j.id) === Number(override)) || null;
      if (!jog) {
        err(`Override de ${u.email} aponta para jogador ${override} que não existe na V1.`);
        stats.erros += 1;
        continue;
      }
    } else {
      const candidatos = porNome.get(primeiroNome(u.nome)) || [];
      if (candidatos.length === 0) {
        // Sem correspondência (ex.: os Pedro Borges) — não é jogador migrável.
        continue;
      }
      if (candidatos.length > 1) {
        skip(`"${u.nome}" (${u.email}) é ambíguo na V1: ${candidatos.map((c) => `${c.nome_jogador}#${c.id}`).join(', ')} → adiciona ao OVERRIDES. Ignorado.`);
        stats.ignorados += 1;
        continue;
      }
      [jog] = candidatos;
    }

    const patch = {
      nome_jogador: jog.nome_jogador || jog.nome || u.nome,
      cor_preferida: ['verde', 'azul', 'vermelho', 'preto'].includes(jog.cor_preferida) ? jog.cor_preferida : null,
    };
    const avatar = avatarUrlDe(jog);
    if (avatar) patch.avatar_url = avatar;

    // Idempotência: só atualiza se algo mudou.
    const mudou =
      u.nome_jogador !== patch.nome_jogador ||
      u.cor_preferida !== patch.cor_preferida ||
      (avatar && u.avatar_url !== avatar);

    if (!mudou) {
      skip(`${u.email} ↔ ${jog.nome_jogador}#${jog.id} — já atualizado.`);
      stats.perfisInalterados += 1;
      continue;
    }

    if (DRY) {
      ok(`[dry] ${u.email} ← ${jog.nome_jogador}#${jog.id} | cor=${patch.cor_preferida} | avatar=${avatar || '(mantém)'}`);
      stats.perfis += 1;
      continue;
    }

    const { error } = await supabase.from('users').update(patch).eq('id', u.id);
    if (error) {
      err(`${u.email}: ${error.message}`);
      stats.erros += 1;
    } else {
      ok(`${u.email} ← ${jog.nome_jogador}#${jog.id} | cor=${patch.cor_preferida} | avatar=${avatar || '(mantém)'}`);
      stats.perfis += 1;
    }
  }
}

// ─── 2. Equipa Domingueira + membros ────────────────────────────────────────────
async function migrarEquipa(v1, usersV2) {
  console.log('\n── 2. EQUIPA + MEMBROS ─────────────────────────────────────');

  const byEmail = new Map(usersV2.map((u) => [u.email, u]));
  const criador = byEmail.get(CRIADOR_EMAIL);
  if (!criador) {
    err(`Criador ${CRIADOR_EMAIL} não existe na V2. Abortado o passo da equipa.`);
    stats.erros += 1;
    return;
  }

  // Equipa (idempotente por slug).
  let team = null;
  const { data: existente } = await supabase.from('teams').select('id, nome, slug').eq('slug', EQUIPA.slug).maybeSingle();
  if (existente) {
    team = existente;
    skip(`Equipa "${EQUIPA.nome}" já existe (${team.id}).`);
  } else if (DRY) {
    ok(`[dry] criaria equipa "${EQUIPA.nome}" (slug ${EQUIPA.slug}, criador ${CRIADOR_EMAIL}).`);
    team = { id: '(dry)', slug: EQUIPA.slug };
  } else {
    const { data, error } = await supabase
      .from('teams')
      .insert({ nome: EQUIPA.nome, slug: EQUIPA.slug, cor: EQUIPA.cor, criado_por: criador.id })
      .select('id, nome, slug')
      .single();
    if (error) {
      err(`Criar equipa: ${error.message}`);
      stats.erros += 1;
      return;
    }
    team = data;
    ok(`Equipa "${EQUIPA.nome}" criada (${team.id}).`);
  }

  // Membros: jogadores migrados (member) + os dois Pedro (admin).
  // Recolhe os user_ids dos jogadores migrados (os que têm nome_jogador definido
  // após o passo 1, ou que cruzam por nome agora).
  const porNome = new Map();
  for (const j of v1.jogadores || []) {
    const k = primeiroNome(j.nome_jogador || j.nome);
    if (!porNome.has(k)) porNome.set(k, []);
    porNome.get(k).push(j);
  }

  const membros = []; // { user, role, pode_postar }
  const vistos = new Set();
  for (const u of usersV2) {
    const ehAdmin = ADMIN_EMAILS.includes(u.email);
    let ehJogador = false;
    if (OVERRIDES[u.email] != null) ehJogador = true;
    else {
      const c = porNome.get(primeiroNome(u.nome)) || [];
      ehJogador = c.length === 1; // só os não-ambíguos
    }
    if (!ehAdmin && !ehJogador) continue;
    if (vistos.has(u.id)) continue;
    vistos.add(u.id);
    membros.push({ user: u, role: ehAdmin ? 'admin' : 'member', pode_postar: ehAdmin });
  }

  for (const m of membros) {
    if (DRY) {
      ok(`[dry] membro ${m.user.email} (${m.role}${m.pode_postar ? ', pode_postar' : ''}).`);
      stats.membros += 1;
      continue;
    }
    // Já é membro?
    const { data: existeM } = await supabase
      .from('team_members')
      .select('id, role')
      .eq('team_id', team.id)
      .eq('user_id', m.user.id)
      .maybeSingle();
    if (existeM) {
      skip(`${m.user.email} já é membro (${existeM.role}).`);
      continue;
    }
    const { error } = await supabase
      .from('team_members')
      .insert({ team_id: team.id, user_id: m.user.id, role: m.role, pode_postar: m.pode_postar });
    if (error) {
      err(`Membro ${m.user.email}: ${error.message}`);
      stats.erros += 1;
    } else {
      ok(`Membro ${m.user.email} (${m.role}${m.pode_postar ? ', pode_postar' : ''}).`);
      stats.membros += 1;
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== Migração V1 → V2 ${DRY ? '(DRY-RUN — sem escrever)' : '(A ESCREVER NA BD)'} ===`);
  try {
    const v1 = lerV1();

    const { data: usersV2, error: ue } = await supabase
      .from('users')
      .select('id, email, nome, nome_jogador, cor_preferida, avatar_url');
    if (ue) {
      err(`Ler users V2: ${ue.message}`);
      if (/nome_jogador|cor_preferida/.test(ue.message)) {
        info('Parece que a migração 012 ainda não foi corrida no Supabase. Corre-a primeiro.');
      }
      process.exitCode = 1;
      return;
    }
    info(`Users V2: ${usersV2.length} | jogadores V1: ${(v1.jogadores || []).length}`);

    await migrarPerfis(v1, usersV2);
    await migrarEquipa(v1, usersV2);

    console.log('\n── RESUMO ──────────────────────────────────────────────────');
    console.log(`Perfis atualizados : ${stats.perfis}`);
    console.log(`Perfis já ok       : ${stats.perfisInalterados}`);
    console.log(`Membros adicionados: ${stats.membros}`);
    console.log(`Ambíguos ignorados : ${stats.ignorados}`);
    console.log(`Erros              : ${stats.erros}`);
    console.log('\nFASE 2 (não executada — decisão "só perfis agora"):');
    console.log('  • Jogos passados (times_resultado, campeão, artilheiro, destaque, rodada)');
    console.log('  • Confirmações de presença');
    console.log('  • Votos (a V1 não associa votos a jogos; a V2 exige game_id)');
    if (DRY) console.log('\n(DRY-RUN: nada foi escrito.)');
    process.exitCode = stats.erros > 0 ? 1 : 0;
  } catch (e) {
    err(e.message);
    process.exitCode = 1;
  }
})();
