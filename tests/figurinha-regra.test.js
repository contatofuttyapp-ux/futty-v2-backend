// Futty v2.0 — Hotfix 26 (25-set): a regra única de "esse avatar é uma figurinha IA".
//
// O motor decidia por avatar_url <> foto_url e a foto do Google, copiada para avatar_url
// pelo trigger handle_new_user, contava como figurinha: "Trocar foto" não trocava o card.
// Aqui se prova a regra em si, sem banco: decide pelo NOME do arquivo (no bucket avatars,
// com -ai-<kit>), e nunca por comparação com foto_url.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { avatarEhFigurinhaNossa, temFigurinhaIA, devePreservarAvatar } = require('../utils/figurinhaRegra');

const B = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public';
const UID = '37e2c87d-571f-4476-9dd9-4292dfc945d3';
const FIGURINHA_NOVA = `${B}/avatars/public/${UID}-ai-dark-gold-1790338033527.png?v=1790338034100`;
const FIGURINHA_ANTIGA = `${B}/avatars/public/${UID}-ai-dark-gold`;
const FOTO = `${B}/avatars/public/${UID}-1790338033527.jpg?v=1790338034100`;
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK-abc=s96-c';

test('figurinha nossa: bucket avatars + -ai-<kit> no nome (as duas gerações de nome)', () => {
  assert.equal(avatarEhFigurinhaNossa(FIGURINHA_NOVA), true);
  assert.equal(avatarEhFigurinhaNossa(FIGURINHA_ANTIGA), true);
});

test('NÃO é figurinha: a foto que a pessoa subiu, a original, a do Google, a silhueta e o resto', () => {
  const naoSao = [
    ['foto nossa', FOTO],
    ['foto original', `${B}/avatars/public/${UID}-original-1790338033527.jpg`],
    ['foto do Google', GOOGLE],
    ['silhueta genérica (bucket kits, as contas da demo)', `${B}/kits/avatar-generico-1.png`],
    ['asset de kit', `${B}/kits/kit1-dark-gold.png`],
    ['-ai- em outro bucket', `${B}/resenha/public/${UID}-ai-dark-gold.png`],
    ['caminho relativo da V1', '/public/avatares/verde/gui.png'],
    ['URL de fora que imita o caminho', 'https://exemplo.invalid/avatars/public/x-ai-y.png'],
    ['vazio', ''],
    ['nulo', null],
    ['indefinido', undefined],
    ['não é texto', 42],
  ];
  for (const [nome, url] of naoSao) assert.equal(avatarEhFigurinhaNossa(url), false, `${nome} não pode contar como figurinha`);
});

test('temFigurinhaIA: slot do pacote, histórico ou avatar de figurinha; "sem sinal" quando a tabela falta', () => {
  assert.equal(temFigurinhaIA({ brilhanteRows: [{}], historicoRows: [], avatarUrl: FOTO }), true, 'slot do pacote');
  assert.equal(temFigurinhaIA({ brilhanteRows: [], historicoRows: [{}], avatarUrl: null }), true, 'histórico');
  assert.equal(temFigurinhaIA({ brilhanteRows: [], historicoRows: [], avatarUrl: FIGURINHA_NOVA }), true, 'avatar atual é figurinha (quem gerou antes da 057)');
  assert.equal(temFigurinhaIA({ brilhanteRows: [], historicoRows: [], avatarUrl: FOTO }), false, 'só a foto');
  assert.equal(temFigurinhaIA({ brilhanteRows: null, historicoRows: null, avatarUrl: null }), false, 'tabelas que faltam = sem sinal, nunca erro');
});

test('o defeito do Google: avatar_url ≠ foto_url com a foto do Google NÃO é figurinha', () => {
  // O estado exato do relato: foto do Google em avatar_url, foto que a pessoa subiu em foto_url.
  assert.notEqual(GOOGLE, FOTO);
  assert.equal(temFigurinhaIA({ brilhanteRows: [], historicoRows: [], avatarUrl: GOOGLE }), false);
});

test('devePreservarAvatar: só preserva figurinha nossa, e nunca no modo "foto"', () => {
  assert.equal(devePreservarAvatar({ avatarUrlAtual: FIGURINHA_NOVA, cardModo: null }), true, 'figurinha, sem escolha de modo');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: FIGURINHA_NOVA, cardModo: 'figurinha' }), true, 'figurinha, modo figurinha');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: FIGURINHA_NOVA, cardModo: 'foto' }), false, 'a escolha explícita "foto" manda o card seguir a foto');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: GOOGLE, cardModo: null }), false, 'foto do Google: nada a preservar, o card tem de mudar');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: FOTO, cardModo: null }), false, 'foto nossa: o card segue a foto nova');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: `${B}/kits/avatar-generico-1.png`, cardModo: null }), false, 'silhueta genérica não é figurinha');
  assert.equal(devePreservarAvatar({ avatarUrlAtual: null, cardModo: null }), false, 'sem avatar_url: a foto nova vira o card');
});
