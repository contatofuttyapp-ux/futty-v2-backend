// Futty v2.0 — A lista "Avise-me" — a parte pura (validar o pedido, ler e contar a lista, montar o CSV).
// Quem recebe o pedido é routes/aviseMe.js; quem mostra a lista é o Gabinete (routes/gabinete.js). Aqui não há Express
// nem rede: o cliente do banco entra por parâmetro, para testar de ponta a ponta sem nada.
//
// O que a lista guarda: o e-mail (minúsculas), de onde veio a pessoa (`origem`) e quando. NADA mais — nem IP, nem
// nome, nem aparelho (LGPD: só o que o aviso do lançamento precisa).

const EMAIL_MAX = 254;
const ORIGEM_MAX = 60;
const TABELA = 'avisos_lancamento';
// Simples de propósito: "algo@dominio.tld", sem espaço nem os separadores que quebram uma lista. A prova de verdade é o
// e-mail do lançamento chegar; aqui só se barra o erro de digitação e o lixo.
const FORMA_DE_EMAIL = /^[^\s@,;:<>()[\]"\\]+@[^\s@,;:<>()[\]"\\]+\.[^\s@,;:<>()[\]"\\]{2,}$/;

/** "  Maria@Gmail.COM " → "maria@gmail.com". */
function normalizarEmail(valor) {
  return String(valor ?? '').trim().toLowerCase();
}

/** De onde veio a pessoa (utm_source/campanha): minúsculas, só letras, números e _ . : / - e espaço; vazio vira "site". */
function limparOrigem(valor) {
  const limpa = String(valor ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:/ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ORIGEM_MAX);
  return limpa || 'site';
}

/**
 * Valida o corpo de POST /api/avise-me.
 *  · `site` é a isca para robô (campo escondido na tela): preenchido, a rota finge que deu certo e não grava nada;
 *  · e-mail vazio ou torto → 400 com a frase que a tela mostra.
 * @returns {{ ok: true, email: string, origem: string } | { ok: true, ignorar: true } | { ok: false, erro: string }}
 */
function validarPedido(corpo) {
  if (typeof corpo?.site === 'string' && corpo.site.trim()) return { ok: true, ignorar: true };
  const email = normalizarEmail(corpo?.email);
  if (!email) return { ok: false, erro: 'Escreva seu e-mail.' };
  if (email.length > EMAIL_MAX || !FORMA_DE_EMAIL.test(email) || email.includes('..')) {
    return { ok: false, erro: 'Esse e-mail não parece certo. Confira e tente de novo.' };
  }
  return { ok: true, email, origem: limparOrigem(corpo?.origem) };
}

/** O erro do banco é "a tabela (migração 068) não existe"? */
function tabelaEmFalta(mensagem) {
  return /avisos_lancamento|does not exist|schema cache/i.test(mensagem || '');
}

/**
 * Lê a lista inteira, do mais recente ao mais antigo, em páginas (o PostgREST corta em 1.000 por resposta).
 * Teto de 50 mil e-mails — muito além do que a lista vai ter antes do lançamento.
 * @returns {Promise<{ indisponivel: boolean, linhas: { id: string, email: string, origem: string, criado_em: string }[] }>}
 */
async function lerTodos(supabase, { pagina = 1000, teto = 50000 } = {}) {
  const linhas = [];
  for (let de = 0; de < teto; de += pagina) {
    const { data, error } = await supabase
      .from(TABELA)
      .select('id, email, origem, criado_em')
      .order('criado_em', { ascending: false })
      .range(de, de + pagina - 1);
    if (error) {
      if (tabelaEmFalta(error.message)) return { indisponivel: true, linhas: [] };
      throw new Error(error.message);
    }
    linhas.push(...(data || []));
    if ((data || []).length < pagina) break;
  }
  return { indisponivel: false, linhas };
}

/** O resumo da aba do Gabinete: total, por origem (do maior para o menor) e os mais recentes. */
function resumir(linhas, { recentes = 100 } = {}) {
  const contagem = new Map();
  for (const l of linhas) contagem.set(l.origem || 'site', (contagem.get(l.origem || 'site') || 0) + 1);
  const por_origem = [...contagem.entries()]
    .map(([origem, total]) => ({ origem, total }))
    .sort((a, b) => b.total - a.total || a.origem.localeCompare(b.origem));
  return { total: linhas.length, por_origem, recentes: linhas.slice(0, recentes) };
}

/**
 * Uma célula do CSV: entre aspas quando precisa (RFC 4180) e, se começa com = + - @ (planilha executaria como fórmula),
 * com um apóstrofo na frente — um e-mail "+fulano@…" é válido e não pode virar fórmula no Excel do dono.
 */
function celulaCsv(valor) {
  let s = String(valor ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** O CSV da lista: cabeçalho + uma linha por e-mail (do mais recente ao mais antigo). */
function montarCsv(linhas) {
  const corpo = linhas.map((l) => [l.email, l.origem, l.criado_em].map(celulaCsv).join(','));
  return ['email,origem,criado_em', ...corpo].join('\r\n') + '\r\n';
}

module.exports = {
  normalizarEmail, limparOrigem, validarPedido, tabelaEmFalta, lerTodos, resumir, celulaCsv, montarCsv, EMAIL_MAX, ORIGEM_MAX, TABELA,
};
