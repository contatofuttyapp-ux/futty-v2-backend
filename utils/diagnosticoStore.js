// Futty v2.0 — Relatórios de diagnóstico do app (VELOCIDADE 4).
//
// O app mede-se a si próprio (frontend/src/lib/diagnostico.js) e a pessoa pode
// enviar o que mediu. Isto guarda esse JSON. À boleia do padrão do
// denunciaStore/gabineteStore: sem DDL, cada relatório é um ficheiro no bucket
// privado "denuncias", debaixo do prefixo "_diagnostico/" — o mesmo sítio onde
// já vive o "_gabinete/operacao.json".
//
// Um ficheiro por envio, nomeado pelo instante: ordenar por nome é ordenar por
// tempo, e não é preciso índice nenhum para saber quais são os últimos.
//
// O que aqui entra não tem corpo de pedido, token nem conteúdo de utilizador —
// só rotas, estados e tempos (ver o que o frontend recolhe).
const { supabase } = require('./db');

const BUCKET = 'denuncias';
const PREFIXO = '_diagnostico';

// Um relatório são ~50 chamadas e ~50 navegações: uns 30 KB. Meio MB é folga
// larga e trava um envio absurdo antes de ele chegar ao Storage.
const LIMITE_BYTES = 512 * 1024;

// Nomes que entram num caminho do Storage. Sem isto, um `..` vindo do pedido
// escrevia/lia fora da pasta.
const ID_SEGURO = /^[A-Za-z0-9_-]{1,64}$/;
const FICHEIRO_SEGURO = /^[0-9TZ:.-]{1,40}\.json$/;

function caminho(userId, ficheiro) {
  return `${PREFIXO}/${userId}/${ficheiro}`;
}

/** Guarda um relatório. Devolve o nome do ficheiro criado. */
async function guardarRelatorio(userId, relatorio) {
  if (!ID_SEGURO.test(String(userId))) throw new Error('userId inválido');

  const corpo = Buffer.from(JSON.stringify(relatorio));
  if (corpo.length > LIMITE_BYTES) {
    const e = new Error('Relatório grande demais.');
    e.grande = true;
    throw e;
  }

  // ':' e '.' são válidos num caminho do Storage e mantêm o ISO legível.
  const ficheiro = `${new Date().toISOString()}.json`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(caminho(userId, ficheiro), corpo, { contentType: 'application/json', upsert: true, cacheControl: '0' });
  if (error) throw new Error(error.message);
  return ficheiro;
}

/** Lê um relatório. null se não existir ou não for JSON. */
async function obterRelatorio(userId, ficheiro) {
  if (!ID_SEGURO.test(String(userId)) || !FICHEIRO_SEGURO.test(String(ficheiro))) return null;
  const { data } = await supabase.storage.from(BUCKET).download(caminho(userId, ficheiro));
  if (!data) return null;
  try {
    return JSON.parse(await data.text());
  } catch {
    return null;
  }
}

/**
 * Os `limite` relatórios mais recentes, de todos os utilizadores. O nome do
 * ficheiro é o instante ISO, por isso ordenar por nome é ordenar por tempo.
 * Traz um resumo de cada um (plataforma, médias) — o JSON inteiro só é buscado
 * quando o dono abre um.
 */
async function listarUltimos(limite = 20) {
  const { data: pastas } = await supabase.storage.from(BUCKET).list(PREFIXO, { limit: 200 });
  // Pastas não têm id no Storage do Supabase; ficheiros soltos aqui, se
  // existissem, não interessam.
  const utilizadores = (pastas || []).filter((p) => !p.id).map((p) => p.name);

  const todos = [];
  await Promise.all(
    utilizadores.map(async (userId) => {
      const { data: ficheiros } = await supabase.storage.from(BUCKET).list(`${PREFIXO}/${userId}`, { limit: 100 });
      (ficheiros || [])
        .filter((f) => f.name.endsWith('.json'))
        .forEach((f) => todos.push({ userId, ficheiro: f.name }));
    })
  );

  todos.sort((a, b) => b.ficheiro.localeCompare(a.ficheiro));
  const recentes = todos.slice(0, limite);

  return Promise.all(
    recentes.map(async (r) => {
      const rel = await obterRelatorio(r.userId, r.ficheiro);
      return {
        userId: r.userId,
        ficheiro: r.ficheiro,
        em: rel?.em || r.ficheiro.replace(/\.json$/, ''),
        plataforma: rel?.aparelho?.plataforma || null,
        appVersao: rel?.aparelho?.appVersao || null,
        appBuild: rel?.aparelho?.appBuild || null,
        resumo: rel?.resumo || null,
      };
    })
  );
}

module.exports = { guardarRelatorio, obterRelatorio, listarUltimos };
