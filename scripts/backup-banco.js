// Futty v2.0 — Backup semanal do banco (SEGURANCA-REVISAO-10SET.md secção 4:
// "Backups: no plano free do Supabase não há backup automático. Se alguém
// apagar a tabela, acabou.")
//
// Exporta TODAS as tabelas do schema public para um .json por tabela em
// C:\Users\phfer\Desktop\FUT\BACKUPS\<AAAA-MM-DD>\ (fora dos dois repos).
// Usa a service_role do .env (ignora RLS — vê tudo, como o backend em
// produção). Uso:
//   node backend/scripts/backup-banco.js
//
// LISTA DE TABELAS: fixa (abaixo), não descoberta em runtime — o projeto usa
// só a REST API do Supabase (PostgREST) via SUPABASE_SERVICE_KEY, sem
// connection string de Postgres (sem DATABASE_URL, sem "pg" instalado), e o
// PostgREST não expõe information_schema por padrão (confirmado: consultar
// public.information_schema.tables dá PGRST205). Se criares uma tabela nova,
// ACRESCENTA O NOME AQUI — senão ela fica de fora do backup em silêncio.
const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/db'); // cliente service_role já configurado (ignora RLS)

// NB: campeonatos_v2/campeonato_times/campeonato_confrontos (migração 039,
// modelo de campeonato N-times) ficam DE FORA — testado ao vivo (10-set) e
// confirmado que ainda não existem (PGRST205), a v1 do campeonato guarda tudo
// como JSON no Storage. Junta-as aqui no dia em que a 039 for de facto
// aplicada.
// LIMPEZA TOTAL (23-set) — achado ao preparar o backup pré-limpeza: a lista
// abaixo é anterior à migração 054 (Figurinha Brilhante, 22-set) e nunca foi
// atualizada. pedidos_ativacao e brilhantes_time ficavam de fora em silêncio
// — exatamente o aviso que o comentário do topo do arquivo pede para evitar.
const TABELAS = [
  'users', 'teams', 'team_members', 'games', 'votes',
  'comentarios', 'comentario_anexos', 'feed_posts', 'feed_post_media', 'reacoes',
  'denuncias', 'champion_photos', 'team_join_requests', 'convites', 'game_players',
  'rsvp_espera', 'push_subscriptions', 'campeonatos', 'campeonato_jornadas',
  'gasto_ia_diario', 'gols_jogadores', 'geracao_ia_log', 'app_config', 'user_blocks',
  'share_declarations', 'rsvp_respostas', 'user_avatar_slots',
  'pedidos_ativacao', 'brilhantes_time',
];

const PASTA_BACKUPS = 'C:\\Users\\phfer\\Desktop\\FUT\\BACKUPS';
const TAMANHO_PAGINA = 1000; // limite por pedido do PostgREST (default Supabase)

function hojeISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Lê uma tabela inteira, paginando de TAMANHO_PAGINA em TAMANHO_PAGINA. */
async function exportarTabela(nome) {
  const linhas = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(nome)
      .select('*')
      .range(from, from + TAMANHO_PAGINA - 1);
    if (error) throw error;
    linhas.push(...data);
    if (data.length < TAMANHO_PAGINA) break;
    from += TAMANHO_PAGINA;
  }
  return linhas;
}

async function main() {
  // utils/db.js já valida SUPABASE_URL/SUPABASE_SERVICE_KEY no require acima
  // (process.exit(1) se faltarem) — nada a checar aqui.
  const pastaHoje = path.join(PASTA_BACKUPS, hojeISO());
  fs.mkdirSync(pastaHoje, { recursive: true });

  console.log(`[backup] destino: ${pastaHoje}`);
  let totalLinhas = 0;
  let tabelasOk = 0;
  const falhas = [];

  for (const nome of TABELAS) {
    try {
      const linhas = await exportarTabela(nome);
      fs.writeFileSync(path.join(pastaHoje, `${nome}.json`), JSON.stringify(linhas, null, 2), 'utf8');
      console.log(`[backup] ${nome}: ${linhas.length} linha(s)`);
      totalLinhas += linhas.length;
      tabelasOk += 1;
    } catch (e) {
      console.error(`[backup] ${nome}: FALHOU — ${e.message}`);
      falhas.push(nome);
    }
  }

  console.log('');
  console.log(`[backup] concluído: ${tabelasOk}/${TABELAS.length} tabelas, ${totalLinhas} linha(s) ao todo.`);
  if (falhas.length) {
    console.log(`[backup] falharam: ${falhas.join(', ')}`);
    process.exitCode = 1;
    return; // corrida com falhas — não regista como "último backup" bem-sucedido
  }

  // Gabinete 2.0 (11-set): o semáforo "último backup" da aba Segurança lê daqui.
  // Só grava quando a corrida foi 100% OK (return acima corta o caminho de falha).
  try {
    await supabase.from('app_config').upsert({
      chave: 'ultimo_backup',
      valor: JSON.stringify({ data: hojeISO(), tabelas: tabelasOk, linhas: totalLinhas }),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[backup] aviso: não consegui gravar 'ultimo_backup' em app_config — ${e.message}`);
  }
}

main();
