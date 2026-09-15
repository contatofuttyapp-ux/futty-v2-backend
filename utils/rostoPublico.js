// Futty v2.0 — Privacidade do rosto nas páginas públicas /p/ (Opção B aprovada).
// REGRA DURA (fail-closed): um rosto só se revela numa partilha pública SE o dono
// for ADULTO (>=18, birthdate preenchida) E tiver o consentimento ligado
// (mostrar_rosto_publico, default TRUE). Menor · sem birthdate · sem consentimento
// · convidado sem conta → SILHUETA, sempre. A idade manda mesmo com a flag ligada.
//
// Mecânica: o times_resultado é um snapshot congelado com avatar_url = URL público
// do bucket privado. Para quem PODE revelar, reescrevemos para um URL do PROXY
// (`/api/media/<token>`, público, token HMAC) — que NÃO bate no regex de
// despublicarPayload, logo sobrevive à varredura do middleware. Para quem não pode,
// pomos '' → o frontend cai na silhueta-casa. O middleware fica INTOCADO.
const { parseUrlPublico } = require('./storage');
const { assinarToken } = require('./mediaToken');

/** >=18 anos hoje. Sem birthdate → false (fail-closed). Mesma régua de auth.js. */
function ehAdulto(birthdate) {
  if (!birthdate) return false;
  const limite = new Date();
  limite.setFullYear(limite.getFullYear() - 18);
  return new Date(birthdate) <= limite;
}

/** Pode revelar o rosto? Adulto E consentimento (default TRUE se ausente). */
function podeRevelar(u) {
  return ehAdulto(u && u.birthdate) && (u ? u.mostrar_rosto_publico !== false : false);
}

/**
 * Reescreve, IN-PLACE, os avatar_url de um times_resultado conforme idade+consentimento.
 * @param {object} tr times_resultado ({ times:[{jogadores:[]}], reservas:[] })
 * @param {Map<string,{birthdate,mostrar_rosto_publico}>} usersById dados dos donos
 * @param {string} base origem do backend (ex.: http://localhost:3001) — p/ o proxy
 */
function aplicarRostoPublico(tr, usersById, base) {
  if (!tr || typeof tr !== 'object') return tr;
  const resolver = (j) => {
    if (!j || !j.avatar_url) return;
    const u = j.user_id && usersById ? usersById.get(j.user_id) : null;
    if (u && podeRevelar(u)) {
      const p = parseUrlPublico(j.avatar_url);
      j.avatar_url = p ? `${base}/api/media/${assinarToken(p.bucket, p.path, { v: p.v })}` : '';
    } else {
      j.avatar_url = ''; // menor / sem dob / sem consentimento / convidado → silhueta
    }
  };
  (tr.times || []).forEach((t) => (t.jogadores || []).forEach(resolver));
  (tr.reservas || []).forEach(resolver);
  return tr;
}

module.exports = { ehAdulto, podeRevelar, aplicarRostoPublico };
