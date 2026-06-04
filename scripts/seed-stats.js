// Futty v2.0 — Seed de estatísticas e fotos de campeão para a equipa mock.
//
// 1) Define vitórias/gols/artilharia/destaque aleatórios nos jogadores mock
// 2) Copia algumas fotos da v1 para backend/public/uploads
// 3) Associa essas fotos como "fotos de campeão" a alguns jogadores
//
// Uso:  node scripts/seed-stats.js
// Requer: backend/.env e a migração db/fase7.sql aplicada no Supabase.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[seed] Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY no backend/.env');
  process.exit(1);
}

const TEAM_SLUG = 'teste-1-ktbig';
const V1_AVATARES = 'C:\\Users\\phfer\\Desktop\\FUT\\FUTTY\\backend\\public\\avatares';
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function scanImages(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanImages(full, acc);
    else if (/\.(png|jpe?g|webp)$/i.test(e.name)) acc.push(full);
  }
  return acc;
}

function isMissingSchema(error) {
  if (!error) return false;
  const msg = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  return msg.includes('column') || msg.includes('does not exist') || error.code === 'PGRST204' || error.code === '42703';
}

async function main() {
  // Equipa
  const { data: team } = await supabase
    .from('teams')
    .select('id, nome')
    .eq('slug', TEAM_SLUG)
    .maybeSingle();
  if (!team) throw new Error(`Equipa "${TEAM_SLUG}" não encontrada.`);

  // Jogadores mock (email @futtymock.com)
  const { data: membros } = await supabase
    .from('team_members')
    .select('user_id, users ( id, nome, email )')
    .eq('team_id', team.id);
  const mocks = (membros || []).filter((m) => m.users?.email?.endsWith('@futtymock.com'));
  if (!mocks.length) throw new Error('Não há jogadores mock (@futtymock.com) nesta equipa.');

  console.log(`[seed] Equipa: ${team.nome} | jogadores mock: ${mocks.length}`);

  // 1) Stats aleatórias
  let statsOk = 0;
  for (const m of mocks) {
    const patch = {
      vitorias: rnd(0, 10),
      gols: rnd(0, 15),
      artilharia: rnd(0, 5),
      destaque: rnd(0, 4),
    };
    const { error } = await supabase
      .from('team_members')
      .update(patch)
      .eq('team_id', team.id)
      .eq('user_id', m.user_id);
    if (error) {
      if (isMissingSchema(error)) {
        console.error('\n[seed] ERRO: as colunas de stats não existem.');
        console.error('       Aplica primeiro a migração no Supabase: backend/db/fase7.sql');
        process.exit(1);
      }
      console.error(`  ! ${m.users.nome}: ${error.message}`);
    } else {
      statsOk += 1;
      console.log(`  + ${m.users.nome.padEnd(12)} V:${patch.vitorias} G:${patch.gols} A:${patch.artilharia} D:${patch.destaque}`);
    }
  }

  // 2) Copiar fotos da v1
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fontes = scanImages(V1_AVATARES).slice(0, 6);
  const copiadas = [];
  fontes.forEach((src, i) => {
    const ext = path.extname(src).toLowerCase();
    const dest = `champ_${i + 1}${ext}`;
    try {
      fs.copyFileSync(src, path.join(UPLOADS_DIR, dest));
      copiadas.push(`/uploads/${dest}`);
    } catch (e) {
      console.error(`  ! falha a copiar ${src}: ${e.message}`);
    }
  });
  console.log(`[seed] Fotos copiadas para uploads: ${copiadas.length}`);

  // 3) Associar fotos de campeão a alguns jogadores (2 por jogador, aos 3 primeiros)
  let fotosAssoc = 0;
  if (copiadas.length) {
    // Limpa as fotos atuais da equipa (idempotente)
    const { error: delErr } = await supabase.from('champion_photos').delete().eq('team_id', team.id);
    if (delErr && isMissingSchema(delErr)) {
      console.error('\n[seed] ERRO: a tabela champion_photos não existe.');
      console.error('       Aplica primeiro a migração no Supabase: backend/db/fase7.sql');
      process.exit(1);
    }

    const alvos = mocks.slice(0, 3);
    const TIPOS = ['vitoria', 'artilharia', 'destaque'];
    const rows = [];
    alvos.forEach((m, i) => {
      // 2 fotos por jogador, com tipos variados entre os 3 jogadores
      const a = copiadas[(i * 2) % copiadas.length];
      const b = copiadas[(i * 2 + 1) % copiadas.length];
      rows.push({ team_id: team.id, user_id: m.user_id, url: a, tipo: TIPOS[i % 3] });
      rows.push({ team_id: team.id, user_id: m.user_id, url: b, tipo: TIPOS[(i + 1) % 3] });
    });
    const { error: insErr } = await supabase.from('champion_photos').insert(rows);
    if (insErr) {
      if (isMissingSchema(insErr)) {
        console.error('\n[seed] ERRO: a tabela champion_photos não existe.');
        console.error('       Aplica primeiro a migração no Supabase: backend/db/fase7.sql');
        process.exit(1);
      }
      console.error(`  ! champion_photos: ${insErr.message}`);
    } else {
      fotosAssoc = rows.length;
      alvos.forEach((m) => console.log(`  📸 ${m.users.nome}: 2 fotos de campeão`));
    }
  }

  console.log('\n[seed] Resumo:');
  console.log(`  Stats atualizadas : ${statsOk}/${mocks.length}`);
  console.log(`  Fotos copiadas    : ${copiadas.length}`);
  console.log(`  Fotos associadas  : ${fotosAssoc}`);
}

main().catch((err) => {
  console.error('[seed] ERRO:', err.message);
  process.exit(1);
});
