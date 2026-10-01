// Futty v2.0 — Rodada 29B (bloco 3, E): quem tem recorte de miniatura. Um mapa em memória
// { caminho do arquivo no bucket `avatars` → parâmetro `rc` pronto ("0.500,0.310,1.200") }.
//
// Por que existe. O avatar sai do motor como URL do proxy (`/api/media/<token>`), em dezenas de
// respostas (ranking, sorteio, Resenha, Início…), quase todas montadas SEM a linha do dono do
// avatar. Para a miniatura de TODO MUNDO sair no enquadramento que a pessoa escolheu, o motor
// precisa saber, na hora de proxificar uma URL, se aquele arquivo tem recorte — e fazer isso
// sem uma ida ao banco por resposta. O mapa responde em memória; o banco (users.avatar_recorte,
// migração 070) é a fonte da verdade.
//
// Consistência entre instâncias (Cloud Run pode ter várias): a que recebe a gravação atualiza
// o próprio mapa na hora (escrita direta); todas relêem o banco a cada 2 min (`iniciar`). Uma
// pessoa que muda o recorte pode demorar até 2 min para ser vista no novo enquadramento por quem
// cai noutra instância — é um detalhe cosmético, não vale uma ida ao banco por pedido.
//
// A chave é o arquivo a que o recorte PERTENCE (`avatar_recorte.arquivo`), não o avatar atual:
// trocar de foto/uniforme leva a outro arquivo e o recorte velho para de valer sozinho; voltar ao
// arquivo antigo o traz de volta.
const { paraParametro } = require('./recorteAvatar');

const INTERVALO_MS = 2 * 60 * 1000;
const PAGINA = 1000;
// Escrita direta recente que uma releitura iniciada ANTES dela não pode desfazer.
const JANELA_DA_ESCRITA_MS = 60 * 1000;

let porCaminho = new Map();
const recentes = new Map(); // caminho -> { param: string|null, em: ms } (null = removido agora)
let avisouMigracaoEmFalta = false;
let temporizador = null;

/** O parâmetro `rc` deste arquivo, ou null se não tem recorte. */
function parametroDe(caminho) {
  return typeof caminho === 'string' ? porCaminho.get(caminho) || null : null;
}

/** Escrita direta (a rota que acabou de gravar no banco). */
function registrar(caminho, recorte) {
  const param = paraParametro(recorte);
  if (!caminho || !param) return;
  porCaminho.set(caminho, param);
  recentes.set(caminho, { param, em: Date.now() });
}

function remover(caminho) {
  if (!caminho) return;
  porCaminho.delete(caminho);
  recentes.set(caminho, { param: null, em: Date.now() });
}

/** Só para os testes. */
function limpar() {
  porCaminho = new Map();
  recentes.clear();
  avisouMigracaoEmFalta = false;
}

/**
 * Relê o banco e troca o mapa inteiro (assim um recorte apagado noutra instância some). Falhou?
 * Fica com o que tinha. Devolve true se trocou. Nunca lança.
 */
async function carregar(supabase) {
  const novo = new Map();
  const inicio = Date.now();
  try {
    for (let de = 0; ; de += PAGINA) {
      const { data, error } = await supabase
        .from('users')
        .select('id, avatar_recorte')
        .not('avatar_recorte', 'is', null)
        .order('id')
        .range(de, de + PAGINA - 1);
      if (error) throw new Error(error.message);
      for (const linha of data || []) {
        const j = linha.avatar_recorte;
        const param = paraParametro(j);
        if (param && typeof j.arquivo === 'string' && j.arquivo) novo.set(j.arquivo, param);
      }
      if (!data || data.length < PAGINA) break;
    }
  } catch (e) {
    if (/avatar_recorte|does not exist|schema cache/i.test(e.message)) {
      if (!avisouMigracaoEmFalta) {
        avisouMigracaoEmFalta = true;
        console.warn('[recortes] users.avatar_recorte indisponível (migração 070 aplicada?) — as miniaturas seguem na regra de sempre.');
      }
    } else {
      console.error('[recortes] falha ao carregar (mantém o que já tinha):', e.message);
    }
    return false;
  }
  // O que esta instância escreveu há pouco e a releitura (iniciada antes da escrita) ainda não viu.
  for (const [caminho, r] of recentes) {
    if (Date.now() - r.em > JANELA_DA_ESCRITA_MS) { recentes.delete(caminho); continue; }
    if (r.em < inicio) continue; // a releitura começou depois: o banco já sabe
    if (r.param) novo.set(caminho, r.param); else novo.delete(caminho);
  }
  porCaminho = novo;
  return true;
}

/** Carrega agora (sem esperar) e relê a cada 2 min. O temporizador não segura o processo vivo. */
function iniciar(supabase, { intervaloMs = INTERVALO_MS } = {}) {
  carregar(supabase).then((ok) => { if (ok) console.log(`[Futty] Recortes de miniatura carregados: ${porCaminho.size}`); });
  if (temporizador) clearInterval(temporizador);
  temporizador = setInterval(() => { carregar(supabase); }, intervaloMs);
  if (temporizador.unref) temporizador.unref();
}

function tamanho() {
  return porCaminho.size;
}

module.exports = { parametroDe, registrar, remover, limpar, carregar, iniciar, tamanho, INTERVALO_MS };
