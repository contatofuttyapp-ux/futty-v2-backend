// Futty v2.0 — Rodada 29I (achado 78): o "Artilheiro do dia" depende dos "gols" do time.
//
// Decisão do dono (3-out): quem desliga "Mostrar gols" desliga o artilheiro junto — o texto do próprio "Mostrar gols" diz que ele traz
// "o radar de 5 eixos, o bloco de Gols e o troféu de Artilheiro", então um time com gols desligados e artilheiro ligado se contradiz. O app
// já não deixa montar essa combinação (o artilheiro fica apagado quando os gols estão desligados); o motor também recusa, para nenhum
// app antigo nem pedido à mão gravar o time incoerente. Religar os gols NÃO religa o artilheiro: quem decide é a pessoa.
// Puro (sem banco), para testar no Node.

const MSG_ARTILHEIRO_PRECISA_DOS_GOLS = 'O artilheiro precisa dos gols ligados.';

/** `true` = gols ligados (o padrão de um time sem a coluna ou sem valor); `false` só quando está explicitamente desligado. */
const ligado = (v) => v !== false;

/**
 * A combinação final é coerente? Só é incoerente com gols desligados E artilheiro ligado.
 * Os dois valores são os que o time vai TER depois da gravação (o do pedido, ou o que já estava).
 */
function combinacaoDePremiosCoerente({ mostrar_gols: gols, mostrar_artilheiro: artilheiro }) {
  return ligado(gols) || !ligado(artilheiro);
}

module.exports = { MSG_ARTILHEIRO_PRECISA_DOS_GOLS, combinacaoDePremiosCoerente };
