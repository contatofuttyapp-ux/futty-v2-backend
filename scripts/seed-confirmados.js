// Futty v2.0 — Confirma todos os membros da equipa no jogo mais recente.
//
// Uso:  node scripts/seed-confirmados.js
// Requer: backend/.env com SUPABASE_URL e SUPABASE_SERVICE_KEY.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[seed] Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY no backend/.env');
  process.exit(1);
}

const TEAM_SLUG = 'teste-1-ktbig';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  // 1) Equipa
  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .select('id, nome, slug')
    .eq('slug', TEAM_SLUG)
    .maybeSingle();
  if (teamErr) throw new Error(`teams: ${teamErr.message}`);
  if (!team) throw new Error(`Equipa "${TEAM_SLUG}" não encontrada.`);

  // 1b) Jogo mais recente (último criado)
  const { data: game, error: gameErr } = await supabase
    .from('games')
    .select('id, data, local, status, jogadores_por_time, created_at')
    .eq('team_id', team.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (gameErr) throw new Error(`games: ${gameErr.message}`);
  if (!game) throw new Error(`A equipa "${team.nome}" ainda não tem jogos. Cria um primeiro.`);

  console.log(`[seed] Equipa: ${team.nome}`);
  console.log(`[seed] Jogo:   ${game.id}`);
  console.log(`        ${game.local || '(sem local)'} · ${new Date(game.data).toLocaleString('pt-PT')} · ${game.jogadores_por_time || '?'} por time`);

  // 2) Membros da equipa
  const { data: membros, error: memErr } = await supabase
    .from('team_members')
    .select('user_id, users ( nome, email )')
    .eq('team_id', team.id);
  if (memErr) throw new Error(`team_members: ${memErr.message}`);

  console.log(`[seed] Membros a confirmar: ${membros.length}`);

  // 3) Confirma todos (upsert idempotente)
  const rows = membros.map((m) => ({
    game_id: game.id,
    user_id: m.user_id,
    confirmado: true,
  }));

  const { error: upErr } = await supabase
    .from('game_players')
    .upsert(rows, { onConflict: 'game_id,user_id' });
  if (upErr) throw new Error(`game_players upsert: ${upErr.message}`);

  // 4) Mostra o resultado
  const { data: confirmados, error: confErr } = await supabase
    .from('game_players')
    .select('confirmado, goleiro, users ( nome, email )')
    .eq('game_id', game.id)
    .eq('confirmado', true)
    .order('created_at', { ascending: true });
  if (confErr) throw new Error(`leitura: ${confErr.message}`);

  console.log(`\n[seed] Confirmados neste jogo: ${confirmados.length}`);
  confirmados.forEach((p, i) => {
    const nome = p.users?.nome || p.users?.email || '?';
    console.log(`  ${String(i + 1).padStart(2)}. ${nome.padEnd(14)} ${p.goleiro ? '(GR)' : ''}`);
  });
}

main().catch((err) => {
  console.error('[seed] ERRO:', err.message);
  process.exit(1);
});
