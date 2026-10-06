// Futty v2.0 — O dono escolhe o uniforme do pacote do time.
//
// O pacote comprado na LOJA liga o time sem uniforme quando o time ainda não tinha
// `brilhante_kit` (nenhum pedido guarda uniforme) — e sem uniforme ninguém gera (direitoBrilhante
// salta pacote sem kit). Por isso o próprio dono escolhe:
//   · só o admin do time;
//   · só com o pacote ativo;
//   · a 1ª escolha sempre vale; trocar, só enquanto ninguém gerou (depois disso o time já tem
//     figurinhas num uniforme, e trocar deixaria o álbum com dois — fala com o suporte).
// Na 1ª escolha os membros recebem o push "Sua figurinha foi liberada" (é agora que dá para gerar).
//
// Fábrica com o Supabase e o push injetáveis: tests/uniforme-do-pacote.test.js corre sem banco.
const { supabase: supabaseReal } = require('./db');
const { HttpError } = require('./http');

function notificarReal(ids, payload) {
  // eslint-disable-next-line global-require
  return require('../routes/push').enviarNotificacao(ids, payload);
}

function criarUniformeDoPacote({ supabase = supabaseReal, notificar = notificarReal } = {}) {
  /**
   * Fixa o uniforme do pacote. `kitsValidos` = os ids de KITS_IA ativos (routes/auth.js).
   * Devolve { kit_id, primeira_escolha, membros_avisados }. Lança HttpError 400/403/404/409.
   */
  async function escolherUniforme({ teamId, userId, kitId, kitsValidos }) {
    if (!kitsValidos.includes(kitId)) throw new HttpError(400, 'Uniforme inválido.', 'KIT_INVALIDO');

    const { data: time, error: erroTime } = await supabase
      .from('teams').select('id, nome, brilhante_ativo, brilhante_kit').eq('id', teamId).maybeSingle();
    if (erroTime) throw new HttpError(500, erroTime.message);
    if (!time) throw new HttpError(404, 'Time não encontrado.');

    const { data: membro, error: erroMembro } = await supabase
      .from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    if (erroMembro) throw new HttpError(500, erroMembro.message);
    if (membro?.role !== 'admin') throw new HttpError(403, 'Só o dono do time escolhe o uniforme.', 'SO_DONO');

    if (!time.brilhante_ativo) throw new HttpError(409, 'O pacote do time não está ativo.', 'SEM_PACOTE');
    if (time.brilhante_kit === kitId) return { kit_id: kitId, primeira_escolha: false, membros_avisados: 0 };

    if (time.brilhante_kit) {
      const { count, error: erroConta } = await supabase
        .from('brilhantes_time').select('user_id', { count: 'exact', head: true }).eq('team_id', teamId);
      if (erroConta) throw new HttpError(500, erroConta.message);
      if (count) {
        throw new HttpError(409, 'O time já tem figurinhas neste uniforme. Para trocar, fale com o suporte.', 'UNIFORME_EM_USO');
      }
    }

    const { error } = await supabase.from('teams').update({ brilhante_kit: kitId }).eq('id', teamId).eq('brilhante_ativo', true);
    if (error) throw new HttpError(500, error.message);

    const primeira = !time.brilhante_kit;
    let avisados = 0;
    if (primeira) {
      // É agora que o pacote passa a valer para os membros: o push é o que os faz abrir.
      const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
      const ids = (membros || []).map((m) => m.user_id).filter(Boolean);
      avisados = ids.length;
      notificar(ids, {
        title: 'Sua figurinha foi liberada ✨',
        body: `O ${time.nome} escolheu o uniforme. Abra e gere a sua.`,
        url: '/figurinha',
      });
    }
    console.log('[uniformeDoPacote] uniforme escolhido', { teamId, kitId, primeira, avisados });
    return { kit_id: kitId, primeira_escolha: primeira, membros_avisados: avisados };
  }

  return { escolherUniforme };
}

module.exports = { ...criarUniformeDoPacote(), criarUniformeDoPacote };
