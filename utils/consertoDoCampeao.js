// Futty v2.0 — Conserto dos jogos ANTIGOS que têm `time_vencedor` e não têm `campeao_time_index`.
//
// Antes de o campeão ser a verdade (utils/resultadoDoJogo.js), a tela do jogo gravava só `time_vencedor` ('A' | 'B') e Ajustes → Jogos só o campeão. Os jogos
// lançados pela tela do jogo ficaram sem campeão: sem post na Resenha e fora das conquistas do perfil. Este conserto preenche o campeão a partir do
// `time_vencedor` (A → 0, B → 1). A leitura do ranking já tolera esses jogos (resultadoGravado), mas a Resenha só enxerga o campeão.
//
// O que NÃO faz: não troca um campeão que já existe (campeão manda, mesmo que `time_vencedor` diga outra coisa — esses ficam listados como "divergentes");
// não inventa campeão para jogo sem times, nem para jogo com gols mas sem vencedor; não mexe em empate (já é explícito).
//
// Puro na decisão (planoDoConserto) e com o cliente do banco por parâmetro (executarConserto) — quem chama é scripts/consertar-campeao-antigo.js, que só
// grava com --sim. Sem --sim, nenhum UPDATE é chamado: a leitura é a única coisa que sai.

const LETRA_PARA_INDICE = { A: 0, B: 1 };
const PAGINA = 1000;

/**
 * Decide o que fazer com cada jogo lido. Cada jogo vem com: id, team_id, data, time_vencedor, campeao_time_index, times_resultado.
 * @returns {{ conserta: object[], semTimes: object[], divergentes: object[], jaCertos: number }}
 *   conserta: [{ id, team_id, data, time_vencedor, campeao_time_index (o que vai ser gravado) }]
 *   semTimes: tem time_vencedor mas o jogo não tem os times (nada a que apontar)
 *   divergentes: já tem campeão e ele não é o que time_vencedor diz (o campeão manda; só informa)
 */
function planoDoConserto(jogos) {
  const plano = { conserta: [], semTimes: [], divergentes: [], jaCertos: 0 };
  for (const g of jogos || []) {
    const idx = LETRA_PARA_INDICE[g.time_vencedor];
    if (idx === undefined) continue; // 'empate' (já explícito) ou sem vencedor: fora do conserto
    const temCampeao = Number.isInteger(g.campeao_time_index) && g.campeao_time_index >= 0;
    const resumo = { id: g.id, team_id: g.team_id, data: g.data, time_vencedor: g.time_vencedor, campeao_time_index: g.campeao_time_index ?? null };
    if (temCampeao) {
      if (g.campeao_time_index === idx) plano.jaCertos += 1;
      else plano.divergentes.push(resumo);
      continue;
    }
    const nTimes = Array.isArray(g.times_resultado?.times) ? g.times_resultado.times.length : 0;
    if (nTimes <= idx) plano.semTimes.push(resumo);
    else plano.conserta.push({ ...resumo, campeao_time_index: idx });
  }
  return plano;
}

/** Lê, em páginas, todos os jogos que têm time_vencedor A ou B (o campeão e os times vêm junto). */
async function lerJogosComVencedor(supabase) {
  const todos = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await supabase
      .from('games')
      .select('id, team_id, data, time_vencedor, campeao_time_index, times_resultado')
      .in('time_vencedor', ['A', 'B'])
      .order('id', { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) throw new Error(`games: ${error.message}`);
    todos.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return todos;
}

/** Quantos jogos têm resultado (nível > 0) mas nem campeão nem vencedor — gols sem vencedor: não há de onde derivar, ficam como estão. */
async function contarSemComoDerivar(supabase) {
  const { count, error } = await supabase
    .from('games')
    .select('id', { count: 'exact', head: true })
    .gt('resultado_nivel', 0)
    .is('time_vencedor', null)
    .is('campeao_time_index', null);
  if (error) throw new Error(`games: ${error.message}`);
  return count || 0;
}

/**
 * Executa o conserto. Sem `sim`, SÓ LÊ e devolve o que faria; com `sim`, grava o campeão de cada jogo de `conserta` — e só onde o campeão ainda está
 * vazio (um jogo corrigido por alguém entre a leitura e a escrita não é pisado).
 * @param {object} supabase o cliente do banco
 * @param {{ sim?: boolean }} [opcoes]
 * @returns {Promise<{ plano: object, semComoDerivar: number, gravados: number, falhas: Array<{ id: string, erro: string }> }>}
 */
async function executarConserto(supabase, { sim = false } = {}) {
  const [jogos, semComoDerivar] = await Promise.all([lerJogosComVencedor(supabase), contarSemComoDerivar(supabase)]);
  const plano = planoDoConserto(jogos);
  const resultado = { plano, semComoDerivar, gravados: 0, falhas: [] };
  if (!sim) return resultado;
  for (const j of plano.conserta) {
    const { error } = await supabase.from('games').update({ campeao_time_index: j.campeao_time_index }).eq('id', j.id).is('campeao_time_index', null);
    if (error) resultado.falhas.push({ id: j.id, erro: error.message });
    else resultado.gravados += 1;
  }
  return resultado;
}

module.exports = { planoDoConserto, executarConserto, lerJogosComVencedor };
