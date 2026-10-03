// Futty v2.0 — Rodada 29I, bloco 3 (item 74 da Rodada 29): o link curto do sorteio, futtyapp.com.br/s/<código>.
//
// O MESMO molde do link curto do convite (utils/conviteCodigo.js, /c/<código>): o sorteio continua morando em /p/<slug>/<id do jogo>
// — esse link segue valendo, igual —, e o código é só outro jeito de chegar ao MESMO jogo (tabela `sorteio_codigos`, migração 078;
// um código por jogo, some junto com o jogo). Mesmo alfabeto e tamanho do convite (gerarCodigo/lerCodigo vêm de lá).
const { gerarCodigo, lerCodigo } = require('./conviteCodigo');

/**
 * O código do jogo — o que já existe, ou um novo gravado agora. Colisão (23505 no código) tenta de novo com outro; corrida no
 * mesmo jogo (23505 no game_id: duas pessoas tocaram "Copiar link" juntas) lê o que ganhou. Sem a tabela (078 por aplicar), null:
 * o app manda o link longo. Nunca lança.
 */
async function codigoDoSorteio(supabase, gameId, { tentativas = 5, gerar = gerarCodigo } = {}) {
  try {
    const existente = await supabase.from('sorteio_codigos').select('codigo').eq('game_id', gameId).maybeSingle();
    if (existente.error) {
      console.warn('[sorteio] sorteio_codigos indisponível (migração 078 aplicada?):', existente.error.message);
      return null;
    }
    if (existente.data?.codigo) return existente.data.codigo;
    for (let i = 0; i < tentativas; i += 1) {
      const codigo = gerar();
      const { error } = await supabase.from('sorteio_codigos').insert({ codigo, game_id: gameId });
      if (!error) return codigo;
      if (error.code !== '23505') return null;
      const { data: ganhou } = await supabase.from('sorteio_codigos').select('codigo').eq('game_id', gameId).maybeSingle();
      if (ganhou?.codigo) return ganhou.codigo;
    }
  } catch {
    // o link longo continua valendo
  }
  return null;
}

/** O id do jogo que o código nomeia, ou null (código com cara errada, inexistente, ou sem a tabela). Uma ida só. */
async function jogoDoCodigo(supabase, parametro) {
  const codigo = lerCodigo(parametro);
  if (!codigo) return null;
  const { data, error } = await supabase.from('sorteio_codigos').select('game_id').eq('codigo', codigo).maybeSingle();
  if (error || !data) return null;
  return data.game_id || null;
}

module.exports = { codigoDoSorteio, jogoDoCodigo };
