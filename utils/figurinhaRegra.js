// Futty v2.0 — A regra ÚNICA de "esse avatar é uma figurinha IA" (Rodada 20, corrigida no
// Hotfix 26, 25-set).
//
// O motor decidia por `avatar_url <> foto_url`. Só que o trigger handle_new_user (001)
// copiava a foto de perfil da conta Google para users.avatar_url, então quem entrava com
// o Google "tinha figurinha" sem nunca ter gerado: a foto nova ia para foto_url e o card
// (avatar_url) nunca mudava. Comparar URLs não diz o que o arquivo é; o nome dele diz.

// O que o Supabase põe antes do caminho de um objeto público (getPublicUrl). É a forma que
// fica em users.avatar_url; o proxy /api/media só existe na RESPOSTA, nunca no banco.
const MARCADOR_BUCKET_AVATARS = '/storage/v1/object/public/avatars/';

/**
 * O avatar é uma figurinha NOSSA: mora no bucket `avatars` e leva `-ai-<kit>` no nome
 * (`public/<userId>-ai-<kit>-<carimbo>.png`, ou `...-ai-<kit>` nas antigas). A foto sobe
 * como `public/<userId>-<carimbo>.<ext>`, sem `-ai-`; e um UUID é hexadecimal, então a
 * sequência "-ai-" não aparece nele. Uma foto do Google, uma silhueta do bucket `kits` ou
 * qualquer URL de fora nunca casa.
 */
function avatarEhFigurinhaNossa(avatarUrl) {
  if (typeof avatarUrl !== 'string') return false;
  const i = avatarUrl.indexOf(MARCADOR_BUCKET_AVATARS);
  if (i === -1) return false;
  const caminho = avatarUrl.slice(i + MARCADOR_BUCKET_AVATARS.length).split('?')[0];
  return /^public\/[^/]+-ai-[^/]+$/.test(caminho);
}

/**
 * O `tem_figurinha` de /api/me: existe alguma figurinha na vida dessa pessoa? Três sinais:
 * uma linha em brilhantes_time (slot do pacote do time), uma em user_avatar_historico
 * (migração 057) ou o avatar ATUAL ser um arquivo gerado por nós. Pura: quem já buscou as
 * linhas (services/inicio.js) só chama isto. `null` (tabela que falta) é "sem sinal".
 */
function temFigurinhaIA({ brilhanteRows, historicoRows, avatarUrl }) {
  return !!(brilhanteRows || []).length || !!(historicoRows || []).length || avatarEhFigurinhaNossa(avatarUrl);
}

/**
 * Trocar a foto (POST /api/me/avatar) ou reenquadrá-la (PUT .../recorte) deixa o card
 * como está? Só quando o card não está em modo "foto" (escolha explícita da pessoa, que
 * manda o card seguir a foto) e o avatar atual é mesmo uma figurinha nossa. Sem figurinha,
 * avatar_url vira a foto nova, sempre; e nunca se "preserva" uma foto do Google nem
 * qualquer URL que não seja arquivo nosso. Os sinais de banco do tem_figurinha (slot,
 * histórico) não entram aqui: dizem que a pessoa JÁ GEROU, não que o avatar de agora é
 * figurinha, e preservar um avatar que não é figurinha não protege nada.
 */
function devePreservarAvatar({ avatarUrlAtual, cardModo }) {
  return cardModo !== 'foto' && avatarEhFigurinhaNossa(avatarUrlAtual);
}

module.exports = { avatarEhFigurinhaNossa, temFigurinhaIA, devePreservarAvatar };
