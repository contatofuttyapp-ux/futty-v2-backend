// Futty v2.0 — Os arquivos do avatar no bucket privado "avatars": caminhos por versão, URL assinado, limpeza da versão anterior,
// o histórico de figurinhas, a foto conferida pelo hash e as fotos recusadas.
const { HttpError } = require('../utils/http');
const { supabase, getUserById } = require('../utils/db');
const { aquecerDerivados } = require('../utils/derivadosMidia');
const { sha256Hex } = require('../utils/antiAbusoIA');
const { ehMigracaoEmFalta } = require('../utils/direitoBrilhante');

// O bucket "avatars" é PRIVADO — um users.foto_url guardado como URL
// "público" do Storage já não é descarregável por ninguém de fora (nem a própria fal.ai,
// que busca a imagem do lado dela). Estas duas funções extraem o CAMINHO desse URL
// legado e emitem um URL ASSINADO de vida curta, o único que a fal consegue mesmo buscar.
function caminhoNoBucket(urlPublico, bucket) {
  if (!urlPublico) return null;
  const marcador = `/object/public/${bucket}/`;
  const i = urlPublico.indexOf(marcador);
  if (i === -1) return null;
  return urlPublico.slice(i + marcador.length).split('?')[0];
}
async function assinarUrlAvatars(caminho, ttlSeg = 600) {
  const { data, error } = await supabase.storage.from('avatars').createSignedUrl(caminho, ttlSeg);
  if (error) throw new Error(`Falha ao assinar URL do avatar: ${error.message}`);
  return data.signedUrl;
}

// ── Nomes de arquivo POR VERSÃO ─────────────────────────────────────────────
//
// O padrão antigo era `public/<userId>.<ext>` para a foto e
// `public/<userId>-ai-<kit>.png` para a figurinha, com upsert por cima. Um caminho que muda de
// conteúdo é um convite a cache velho: navegador, WebView, CDN e qualquer
// proxy pelo caminho podem servir a versão anterior, e não há como pedir para
// esquecerem. Com o carimbo de tempo no nome, cada versão é um OBJETO NOVO —
// URL diferente, cache sem nada a dizer.
//
// Quem já tem arquivo no nome antigo fica como está até trocar de foto: a
// LEITURA sai sempre de `users.foto_url` / `avatar_url`, que guardam o caminho
// completo, e por isso aceita os dois padrões sem saber a diferença.
const caminhoFotoNovo = (userId, ext) => `public/${userId}-${Date.now()}.${ext}`;
// Sufixo "-original" para nunca colidir com o nome do recorte
// (os dois podem nascer no MESMO milissegundo, no mesmo pedido).
const caminhoFotoOriginalNovo = (userId, ext) => `public/${userId}-original-${Date.now()}.${ext}`;
const caminhoFigurinhaNova = (userId, kitId) => `public/${userId}-ai-${kitId}-${Date.now()}.png`;

/**
 * Apaga um objeto do bucket `avatars` que deixou de ser usado.
 * Best-effort de propósito: falhar a limpeza nunca pode derrubar um upload ou
 * uma geração que já correram bem — o pior caso é um arquivo órfão, e isso
 * conta-se no log em vez de se atirar para cima do usuário.
 */
async function apagarAntigo(caminho, motivo) {
  if (!caminho) return;
  try {
    const { error } = await supabase.storage.from('avatars').remove([caminho]);
    if (error) throw new Error(error.message);
    console.log('[avatar] versão anterior apagada', { caminho, motivo });
  } catch (e) {
    console.warn('[avatar] não consegui apagar a versão anterior (fica órfã):', { caminho, motivo, erro: e.message });
  }
}

/**
 * O estado do avatar da pessoa (foto, original, avatar e modo do card), tolerando as migrações
 * 056/057 por correr: o PostgREST recusa a query INTEIRA por uma coluna desconhecida, então cai
 * sem elas, uma de cada vez. `ensureUserRow` já rodou: se ainda vier vazio, é mesmo coluna que falta.
 */
async function lerEstadoDoAvatar(userId, { comOriginal = true } = {}) {
  let atual = comOriginal ? await getUserById(userId, 'foto_url, foto_original_url, avatar_url, card_modo') : null;
  if (!atual) atual = await getUserById(userId, 'foto_url, avatar_url, card_modo');
  if (!atual) atual = await getUserById(userId, 'foto_url, avatar_url');
  return atual;
}

/**
 * O que sobra de trocar a foto e NÃO precisa segurar a resposta:
 *   · apagar a foto e a original anteriores. Só depois de o banco estar gravado: se apagasse
 *     antes e o update falhasse, a pessoa ficava sem foto nenhuma. Fica depois da RESPOSTA
 *     porque já não há update a esperar; o pior caso continua sendo um arquivo órfão (logado);
 *   · deixar prontos os derivados que as telas vão pedir da foto nova (utils/derivadosMidia.js),
 *     a partir dos bytes que o motor já tem: o primeiro pedido da própria pessoa deixa de pagar a
 *     ida ao Storage e o sharp.
 * Não lança e ninguém a espera.
 */
function faxinaDaFotoNova({ atual, caminho, caminhoOriginal, originalUrl, novoAvatarUrl, avatarUrl, buffer, tipo, motivoAntiga = 'recorte reajustado' }) {
  (async () => {
    const tarefas = [];
    // Não se apaga quando o caminho é o mesmo (conta antiga, nome fixo) nem quando o avatar_url
    // ainda aponta para ela (quem nunca gerou figurinha vê a própria foto no card).
    const caminhoAntigo = caminhoNoBucket(atual?.foto_url, 'avatars');
    const aindaEmUso = caminhoAntigo === caminho || caminhoAntigo === caminhoNoBucket(novoAvatarUrl, 'avatars');
    if (caminhoAntigo && !aindaEmUso) tarefas.push(apagarAntigo(caminhoAntigo, motivoAntiga));
    // A original anterior só sai se esta chamada trouxe uma NOVA (senão não haveria original
    // nenhuma sobrevivendo no card de ninguém).
    if (originalUrl) {
      const caminhoOriginalAntigo = caminhoNoBucket(atual?.foto_original_url, 'avatars');
      if (caminhoOriginalAntigo && caminhoOriginalAntigo !== caminhoOriginal) tarefas.push(apagarAntigo(caminhoOriginalAntigo, 'original substituída'));
    }
    tarefas.push(aquecerDerivados({ url: avatarUrl, buffer, tipo }));
    await Promise.all(tarefas);
  })().catch((e) => console.error('[avatar] faxina depois da resposta falhou:', e.message));
}

// Teto de "Minhas figurinhas" (decisão do dono): 10 (Minha Figurinha sozinha já dá 10).
const TETO_HISTORICO_FIGURINHAS = 10;

/**
 * Arquiva a figurinha que acaba de ser substituída em user_avatar_historico
 * em vez de a apagar, e aplica o teto (apaga a mais antiga — linha +
 * arquivo — quando passa disso). Fail-safe: sem a migração 057, cai no
 * comportamento de sempre (apaga a antiga na hora) — nunca acumula lixo à
 * toa só porque o Pedro ainda não correu a migração.
 */
async function arquivarFigurinhaAntiga(userId, kitId, avatarUrlAntigo) {
  const { error: insErr } = await supabase
    .from('user_avatar_historico')
    .insert({ user_id: userId, kit_id: kitId, avatar_url: avatarUrlAntigo, custo_cents: null });
  if (insErr) {
    console.warn('[avatar-ai] user_avatar_historico indisponível (migração 057 por correr?) — apago a antiga como antes:', insErr.message);
    await apagarAntigo(caminhoNoBucket(avatarUrlAntigo, 'avatars'), `figurinha ${kitId} regerada (sem histórico)`);
    return;
  }
  try {
    const { data: linhas, error: selErr } = await supabase
      .from('user_avatar_historico')
      .select('id, avatar_url, criado_em')
      .eq('user_id', userId)
      .order('criado_em', { ascending: false });
    if (selErr) throw new Error(selErr.message);
    const excesso = (linhas || []).slice(TETO_HISTORICO_FIGURINHAS);
    if (!excesso.length) return;
    const { error: delErr } = await supabase.from('user_avatar_historico').delete().in('id', excesso.map((l) => l.id));
    if (delErr) throw new Error(delErr.message);
    for (const l of excesso) await apagarAntigo(caminhoNoBucket(l.avatar_url, 'avatars'), 'teto do histórico de figurinhas');
    console.log('[avatar-ai] histórico acima do teto — removida(s)', { userId, quantas: excesso.length });
  } catch (e) {
    // O arquivo da antiga já está seguro (insert acima deu certo); o teto é
    // limpeza, nunca pode derrubar a geração que acabou de ser entregue.
    console.warn('[avatar-ai] não consegui aplicar o teto do histórico:', e.message);
  }
}

/**
 * Baixa a foto e confirma que é a que a tabela diz ser a atual.
 *
 * Existe por causa do relato de foto nova com figurinha da foto antiga.
 * A causa nunca se reproduziu em bancada — o download autenticado devolveu
 * sempre a versão certa —, mas a verificação é barata e o que ela evita é caro:
 * uma figurinha da foto errada com o dinheiro já gasto. Se o hash não bater,
 * tenta de novo (pode ser propagação), e ao fim de três tentativas recusa sem
 * chamar a fal e sem contar quota.
 */
async function baixarFotoConferida(caminho, hashEsperado) {
  let ultimoHash = null;
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data: blob, error } = await supabase.storage.from('avatars').download(caminho);
    if (error) throw new Error(error.message);
    // eslint-disable-next-line no-await-in-loop
    const buf = Buffer.from(await blob.arrayBuffer());
    ultimoHash = sha256Hex(buf);
    const confere = !hashEsperado || ultimoHash === hashEsperado;
    console.log('[avatar-ai] etapa 0 - foto baixada', {
      caminho,
      tentativa,
      sha256: ultimoHash.slice(0, 12),
      esperado: (hashEsperado || '(sem hash gravado)').slice(0, 12),
      confere,
    });
    if (confere) return buf;
    if (tentativa < 3) {
      console.warn('[avatar-ai] a foto baixada não é a atual — espero 2 s e tento de novo');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('[avatar-ai] RECUSADO: a foto baixada continua diferente da atual', {
    caminho, baixado: ultimoHash?.slice(0, 12), esperado: hashEsperado?.slice(0, 12),
  });
  throw new HttpError(
    409,
    'Sua foto ainda está sendo preparada. Tente de novo em instantes.',
    'FOTO_DESATUALIZADA',
  );
}

// Decisão do dono: cabeça cortada (ou braço extremo na lateral) nas DUAS tentativas → a FOTO fica recusada. Um pedido novo com a
// mesma foto é barrado ANTES da fal (FOTO_RECUSADA), sem débito. A identidade é o foto_hash (sha256 dos bytes
// da foto guardada), não o nome do arquivo nem a conta: foto nova = hash novo = libera. Migração 080 (fotos_recusadas).
const MSG_FOTO_RECUSADA = 'Essa foto não deu certo. Escolha outra: de frente, com a cabeça e os ombros inteiros aparecendo, sem nada cortado nas bordas.';

async function fotoEstaRecusada(fotoHash) {
  if (!fotoHash) return false;
  const { data, error } = await supabase
    .from('fotos_recusadas')
    .select('foto_hash')
    .eq('foto_hash', fotoHash)
    .maybeSingle();
  if (error) {
    // Migração 080 por correr: sem a tabela não há bloqueio — o pedido segue como antes (fail-safe).
    if (ehMigracaoEmFalta(error.message)) {
      console.warn('[avatar-ai] fotos_recusadas indisponível (migração 080 por correr?):', error.message);
      return false;
    }
    throw new HttpError(500, error.message);
  }
  return !!data;
}

async function recusarFoto(userId, fotoHash) {
  if (!fotoHash) {
    console.warn('[avatar-ai] foto sem foto_hash: não dá para marcá-la como recusada (contas antes da 048)');
    return;
  }
  // ignoreDuplicates: a foto já recusada por outra conta fica com a primeira recusa (quem a recusou primeiro).
  const { error } = await supabase
    .from('fotos_recusadas')
    .upsert({ user_id: userId, foto_hash: fotoHash }, { onConflict: 'foto_hash', ignoreDuplicates: true });
  // Falhar aqui não muda a resposta à pessoa (a figurinha já foi recusada); só deixa a próxima tentativa passar.
  if (error) console.error('[avatar-ai] não consegui marcar a foto como recusada:', error.message);
}

// Conta anterior à migração 048 (sem foto_hash gravado): calcula o hash AGORA, dos bytes do arquivo que está em
// foto_url. É o mesmo sha256 que o upload gravaria (o objeto guardado é o file.buffer). Grava na conta e devolve.
// A escrita só entra se a foto continua a mesma e o hash ainda está vazio: uma foto trocada nesse meio-tempo não
// recebe o hash da antiga. Se não der para ler a foto, devolve null e NÃO bloqueia — a regra normal decide com o
// que houver (sem hash, a recusa e a trava de reuso ficam desligadas, como antes da 048).
async function garantirFotoHash(userId, perfil) {
  if (perfil.foto_hash) return perfil.foto_hash;
  const caminho = caminhoNoBucket(perfil.foto_url, 'avatars');
  if (!caminho) {
    console.warn('[avatar-ai] conta sem foto_hash e foto_url fora do bucket avatars — não calculo; segue sem bloquear');
    return null;
  }
  try {
    const { data: blob, error } = await supabase.storage.from('avatars').download(caminho);
    if (error) throw new Error(error.message);
    const hash = sha256Hex(Buffer.from(await blob.arrayBuffer()));
    perfil.foto_hash = hash;
    const { error: updErr } = await supabase
      .from('users')
      .update({ foto_hash: hash })
      .eq('id', userId)
      .eq('foto_url', perfil.foto_url)
      .is('foto_hash', null);
    if (updErr) console.error('[avatar-ai] foto_hash calculado, mas não gravei na conta:', updErr.message);
    console.log('[avatar-ai] conta sem foto_hash (antes da 048): calculado agora', { userId, sha256: hash.slice(0, 12) });
    return hash;
  } catch (e) {
    console.error('[avatar-ai] conta sem foto_hash e não consegui ler a foto — segue sem bloquear:', e.message);
    return null;
  }
}

module.exports = {
  caminhoNoBucket, assinarUrlAvatars, caminhoFotoNovo, caminhoFotoOriginalNovo, caminhoFigurinhaNova, apagarAntigo, lerEstadoDoAvatar,
  faxinaDaFotoNova, TETO_HISTORICO_FIGURINHAS, arquivarFigurinhaAntiga, baixarFotoConferida, MSG_FOTO_RECUSADA, fotoEstaRecusada, recusarFoto,
  garantirFotoHash,
};
