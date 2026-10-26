// Futty v2.0 — De onde saem as chaves do Supabase.
//
// Só as chaves novas: publishable (sb_publishable_…) e secret (sb_secret_…). Elas
// giram sem derrubar sessões e podem ser revogadas uma a uma; as JWT antigas
// (anon / service_role) estão desligadas no painel e nenhuma variável delas é lida.
// Nenhum outro arquivo lê essas variáveis direto — a fonte é este, uma vez só.
//
// Nunca imprimir o valor: quem precisa saber qual está em uso usa `origemDasChaves()`
// (nomes e formato, sem a chave).

/** A chave de servidor (ignora RLS). Só no motor e nos scripts, nunca no app. */
function chaveSecreta() {
  return process.env.SUPABASE_SECRET_KEY || '';
}

/** A chave pública (a do app, sujeita a RLS). Testes e scripts a usam para abrir sessão. */
function chavePublica() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || '';
}

/**
 * 'nova' (sb_…), 'JWT' ou null — o formato, nunca o conteúdo. Um JWT colado numa variável
 * nova é chave desligada: o log de partida mostra 'JWT' para isso não passar calado.
 */
function formato(chave) {
  if (!chave) return null;
  return chave.startsWith('sb_') ? 'nova' : 'JWT';
}

/** Qual variável manda em cada chave e em que formato — seguro para log. */
function origemDasChaves() {
  return {
    secreta: chaveSecreta() ? 'SUPABASE_SECRET_KEY' : null,
    secretaFormato: formato(chaveSecreta()),
    publica: chavePublica() ? 'SUPABASE_PUBLISHABLE_KEY' : null,
    publicaFormato: formato(chavePublica()),
  };
}

module.exports = { chaveSecreta, chavePublica, origemDasChaves };
