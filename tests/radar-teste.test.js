// Peladas de teste do Radar (RADAR-TESTE.md, 4-out) — testes SEM banco.
// Cobre só cálculo puro: o filtro do --limpar, o próximo jogo no relógio de São Paulo, as coordenadas dentro do DF e a forma
// do que o script grava. Nada aqui toca o Supabase — scripts/radar-teste.js só fala com o banco dentro dos comandos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TIMES, BRASILIA, dentroDoDF, eSlugDoScript, eContaDoScript, proximoJogo, rotuloDoJogo, elencoDe, confirmadosDe, montarTime, emailDe,
} = require('../scripts/radar-teste');
const { partesNoFuso } = require('../utils/fuso');
const { PALETA, PADROES } = require('../utils/escudo');
const { combinacaoDePremiosCoerente } = require('../utils/premiosDoTime');
const { normalizarCidade } = require('../utils/cidade');

const UM_DIA_MS = 24 * 3600 * 1000;

// ─── O filtro do --limpar ───────────────────────────────────────────────────────────────────────────────────────────────

test('eSlugDoScript: só casa radar-teste-<algo>', () => {
  for (const t of TIMES) assert.equal(eSlugDoScript(t.slug), true, t.slug);
  for (const fora of [
    'varzea-fc-teste', 'missa-de-quinta', 'domingueira-fc-demo', 'radar-teste-', 'radar-teste', 'radar-testes-x', 'xradar-teste-x',
    'radar-teste-X', 'radar-teste-a b', 'radar-teste-a%', 'radar-teste-_', '', null, undefined, 42,
  ]) assert.equal(eSlugDoScript(fora), false, String(fora));
});

test('eContaDoScript: só casa teste-radar-<time>-<n>@futtymock.com', () => {
  assert.equal(eContaDoScript('teste-radar-candanga-1@futtymock.com'), true);
  assert.equal(eContaDoScript('teste-radar-parkway-14@futtymock.com'), true);
  for (const fora of [
    'demo-loja@futtymock.com', 'teste-varzea-tonhao@futtymock.com', 'contatofuttyapp@gmail.com', 'teste-radar-candanga-1@gmail.com',
    'teste-radar-candanga-1@futtymock.com.br', 'teste-radar-@futtymock.com', 'teste-radar-candanga@futtymock.com',
    'xteste-radar-candanga-1@futtymock.com', 'teste-radar-candanga-1@futtymock.com ', 'Teste-Radar-candanga-1@futtymock.com',
    'teste-radar-%@futtymock.com', '', null, undefined,
  ]) assert.equal(eContaDoScript(fora), false, String(fora));
});

test('os e-mails que o script gera passam no filtro, e o filtro não pega as contas dos outros times de teste', () => {
  for (const t of TIMES) {
    for (const j of elencoDe(t)) assert.equal(eContaDoScript(j.email), true, j.email);
  }
  assert.equal(emailDe('radar-teste-candanga', 3), 'teste-radar-candanga-3@futtymock.com');
});

// ─── O próximo jogo ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('proximoJogo: dia da semana e hora certos no relógio de São Paulo, para as seis peladas', () => {
  const agora = new Date('2026-10-04T15:00:00Z'); // domingo, 4-out, 12h em São Paulo
  for (const t of TIMES) {
    const j = proximoJogo({ diaDaSemana: t.dia, hora: t.hora }, agora);
    const p = partesNoFuso(j.data, 'America/Sao_Paulo');
    assert.equal(p.diaDaSemana, t.dia, `${t.slug}: dia da semana`);
    assert.equal(`${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`, t.hora, `${t.slug}: hora`);
  }
  // Conferido à mão: quinta 20:00 SP = 23:00 UTC; Cruzeiro (segunda 21:00) a 5-out ainda cabe (>24h); Park Way (domingo) vira o dia 11.
  assert.equal(proximoJogo({ diaDaSemana: 4, hora: '20:00' }, agora).data.toISOString(), '2026-10-08T23:00:00.000Z');
  assert.equal(proximoJogo({ diaDaSemana: 0, hora: '08:00' }, agora).data.toISOString(), '2026-10-11T11:00:00.000Z');
  assert.equal(proximoJogo({ diaDaSemana: 1, hora: '21:00' }, agora).data.toISOString(), '2026-10-06T00:00:00.000Z');
});

test('proximoJogo: nunca no passado, sempre a 1 dia ou mais de agora, e o prazo é a véspera às 18h ainda no futuro — hora a hora, 10 dias pela virada do mês', () => {
  const inicio = Date.UTC(2026, 9, 28, 0, 0, 0); // 28-out-2026, hora a hora até 6-nov: todos os dias da semana e a virada de mês
  for (let h = 0; h < 24 * 10; h += 1) {
    const agora = new Date(inicio + h * 3600 * 1000);
    for (const t of TIMES) {
      const j = proximoJogo({ diaDaSemana: t.dia, hora: t.hora }, agora);
      assert.ok(j.data.getTime() - agora.getTime() >= UM_DIA_MS, `${t.slug} a ${agora.toISOString()}: a menos de 1 dia`);
      assert.ok(j.data.getTime() - agora.getTime() <= 9 * UM_DIA_MS, `${t.slug} a ${agora.toISOString()}: longe demais (${rotuloDoJogo(j.data)})`);
      assert.ok(j.prazo.getTime() > agora.getTime(), `${t.slug} a ${agora.toISOString()}: prazo no passado`);
      assert.ok(j.prazo.getTime() < j.data.getTime(), `${t.slug}: prazo depois do jogo`);
      const pd = partesNoFuso(j.data, 'America/Sao_Paulo');
      const pp = partesNoFuso(j.prazo, 'America/Sao_Paulo');
      assert.equal(pd.diaDaSemana, t.dia);
      assert.equal(`${String(pp.hora).padStart(2, '0')}:${String(pp.minuto).padStart(2, '0')}`, '18:00', `${t.slug}: prazo às 18h`);
      assert.equal(pp.diaDaSemana, (t.dia + 6) % 7, `${t.slug}: prazo na véspera`);
    }
  }
});

test('proximoJogo: vira o mês e o ano', () => {
  // Sábado 31-out-2026, 12h em SP → próxima quinta é 5-nov.
  const virouMes = proximoJogo({ diaDaSemana: 4, hora: '20:00' }, new Date('2026-10-31T15:00:00Z'));
  assert.deepEqual(
    (({ ano, mes, dia }) => [ano, mes, dia])(partesNoFuso(virouMes.data, 'America/Sao_Paulo')),
    [2026, 11, 5],
  );
  // Quarta 30-dez-2026 → sábado é 2-jan-2027.
  const virouAno = proximoJogo({ diaDaSemana: 6, hora: '09:00' }, new Date('2026-12-30T15:00:00Z'));
  assert.deepEqual(
    (({ ano, mes, dia }) => [ano, mes, dia])(partesNoFuso(virouAno.data, 'America/Sao_Paulo')),
    [2027, 1, 2],
  );
});

test('proximoJogo: "hoje" é o de São Paulo, não o do UTC (23h SP já é o dia seguinte em UTC)', () => {
  // Quarta 7-out, 22h em SP = quinta 8-out 01:00 UTC. Quinta 20h SP é a de amanhã (8-out) a só 22h → não cabe; vale a de 15-out.
  const j = proximoJogo({ diaDaSemana: 4, hora: '20:00' }, new Date('2026-10-08T01:00:00Z'));
  assert.equal(j.data.toISOString(), '2026-10-15T23:00:00.000Z');
});

// ─── As coordenadas ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('as seis coordenadas caem dentro do DF (lat −15,50 a −16,05; lng −47,30 a −48,30)', () => {
  assert.equal(TIMES.length, 6);
  for (const t of TIMES) assert.equal(dentroDoDF(t.lat, t.lng), true, `${t.slug}: ${t.lat}, ${t.lng}`);
  assert.equal(dentroDoDF(BRASILIA.lat, BRASILIA.lng), true);
  // O filtro de fato recusa o que está fora (São Paulo, Goiânia, e um ponto trocado de sinal).
  assert.equal(dentroDoDF(-23.55, -46.63), false);
  assert.equal(dentroDoDF(-16.68, -49.25), false);
  assert.equal(dentroDoDF(15.85, -47.95), false);
});

// ─── A tabela e o que se grava ──────────────────────────────────────────────────────────────────────────────────────────

test('a tabela bate com o RADAR-TESTE.md: nomes, regiões, entrada e tamanho do elenco', () => {
  const esperado = {
    'radar-teste-candanga': ['Racha da Candanga', 'Candangolândia', 'publico_aberto', 12, 4, '20:00'],
    'radar-teste-bandeirante': ['Pelada do Bandeirante', 'Núcleo Bandeirante', 'publico_aprovacao', 15, 2, '21:00'],
    'radar-teste-guara': ['Racha do Guará', 'Guará', 'publico_aberto', 18, 6, '09:00'],
    'radar-teste-riacho': ['Rachão do Riacho', 'Riacho Fundo', 'publico_aprovacao', 10, 3, '20:30'],
    'radar-teste-parkway': ['Fut de Domingo Park Way', 'Park Way', 'publico_aberto', 14, 0, '08:00'],
    'radar-teste-cruzeiro': ['Boleiros do Cruzeiro', 'Cruzeiro', 'publico_aprovacao', 11, 1, '21:00'],
  };
  assert.deepEqual(TIMES.map((t) => t.slug).sort(), Object.keys(esperado).sort());
  for (const t of TIMES) {
    const [nome, regiao, modo, jogadores, dia, hora] = esperado[t.slug];
    assert.deepEqual([t.nome, t.regiao, t.modo, t.elenco.length, t.dia, t.hora], [nome, regiao, modo, jogadores, dia, hora], t.slug);
  }
});

test('elenco: o primeiro é o admin, 1 ou 2 goleiros, adultos, apelidos e e-mails únicos', () => {
  const apelidos = new Set();
  const emails = new Set();
  const limite = new Date().getFullYear() - 19; // 18+ com folga de um ano
  for (const t of TIMES) {
    const elenco = elencoDe(t);
    assert.equal(elenco.length, t.elenco.length);
    assert.equal(elenco.filter((j) => j.admin).length, 1, `${t.slug}: um admin só`);
    assert.equal(elenco[0].admin, true, `${t.slug}: o primeiro é o admin`);
    assert.equal(elenco[0].gr, false, `${t.slug}: o admin joga na linha`);
    const goleiros = elenco.filter((j) => j.gr).length;
    assert.ok(goleiros >= 1 && goleiros <= 2, `${t.slug}: ${goleiros} goleiros`);
    for (const j of elenco) {
      assert.match(j.nasc, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number(j.nasc.slice(0, 4)) <= limite, `${j.apelido}: nascido em ${j.nasc} não é adulto garantido`);
      assert.match(j.av, /^[mf][1-3]$/);
      assert.ok(!apelidos.has(j.apelido), `apelido repetido entre os times: ${j.apelido}`);
      assert.ok(!emails.has(j.email), `e-mail repetido: ${j.email}`);
      apelidos.add(j.apelido);
      emails.add(j.email);
    }
  }
  assert.equal(apelidos.size, 12 + 15 + 18 + 10 + 14 + 11);
});

test('o elenco é o mesmo a cada chamada (determinístico) e usa os seis avatares genéricos no conjunto', () => {
  assert.deepEqual(elencoDe(TIMES[0]), elencoDe(TIMES[0]));
  const usados = new Set(TIMES.flatMap((t) => elencoDe(t).map((j) => j.av)));
  assert.deepEqual([...usados].sort(), ['f1', 'f2', 'f3', 'm1', 'm2', 'm3']);
});

test('confirmados: de 4 a 9 por time, sem repetir, sempre com o admin', () => {
  for (const t of TIMES) {
    const quem = confirmadosDe(t);
    assert.equal(quem.length, t.jogo.confirmados);
    assert.ok(quem.length >= 4 && quem.length <= 9, `${t.slug}: ${quem.length}`);
    assert.equal(new Set(quem).size, quem.length);
    assert.ok(quem.includes(0), `${t.slug}: o admin confirma`);
    assert.ok(quem.every((i) => i >= 0 && i < t.elenco.length));
    assert.ok(quem.length <= t.jogo.max, `${t.slug}: mais confirmados que o teto do jogo`);
  }
});

test('escudo e prêmios: valores válidos da 077, combinações coerentes, variados, com um time todo desligado e um todo ligado', () => {
  for (const t of TIMES) {
    assert.ok(PALETA.includes(t.escudo.cor), `${t.slug}: cor ${t.escudo.cor}`);
    if (t.escudo.cor2 != null) assert.ok(PALETA.includes(t.escudo.cor2) && t.escudo.cor2 !== t.escudo.cor, `${t.slug}: cor2`);
    if (t.escudo.padrao != null) assert.ok(PADROES.includes(t.escudo.padrao) && t.escudo.padrao !== 'solido', `${t.slug}: padrão`);
    assert.ok(combinacaoDePremiosCoerente({ mostrar_gols: t.premios.gols, mostrar_artilheiro: t.premios.artilheiro }), `${t.slug}: artilheiro sem gols`);
  }
  assert.ok(new Set(TIMES.map((t) => t.escudo.cor)).size >= 5, 'cores variadas');
  assert.ok(new Set(TIMES.map((t) => t.escudo.padrao)).size >= 5, 'padrões variados');
  const valores = (t) => Object.values(t.premios);
  assert.ok(TIMES.some((t) => valores(t).every((v) => v === true)), 'um time com tudo ligado');
  assert.ok(TIMES.some((t) => valores(t).every((v) => v === false)), 'um time com tudo desligado');
});

test('montarTime: a cidade, o bairro e o ponto saem como o motor grava "Brasília, DF" + bairro', async () => {
  for (const t of TIMES) {
    const linha = await montarTime(t, 'id-do-admin');
    assert.equal(linha.slug, t.slug);
    assert.equal(linha.nome, t.nome);
    assert.equal(linha.cidade, 'Brasília, DF');
    assert.equal(linha.cidade_normalizada, 'brasilia');
    assert.equal(linha.bairro, t.regiao);
    assert.equal(linha.bairro_normalizado, normalizarCidade(t.regiao));
    assert.equal(linha.localizacao, `${t.regiao}, Brasília, DF`);
    assert.equal(linha.geo_lat, t.lat);
    assert.equal(linha.geo_lng, t.lng);
    assert.equal(linha.fuso, 'America/Sao_Paulo');
    assert.equal(linha.modo_visibilidade, t.modo);
    assert.equal(linha.publica, true);
    assert.equal(linha.criado_por, 'id-do-admin');
    assert.match(linha.descricao, /demonstração/);
    assert.ok(linha.descricao.length <= 300);
    assert.equal('logo_url' in linha, false, 'sem logo');
    assert.equal(linha.cor, t.escudo.cor);
    assert.equal(linha.escudo_cor2, t.escudo.cor2);
    assert.equal(linha.escudo_padrao, t.escudo.padrao);
    assert.equal(linha.mostrar_gols, t.premios.gols);
    assert.equal(linha.mostrar_artilheiro, t.premios.artilheiro);
    assert.equal(linha.mostrar_destaque, t.premios.destaque);
  }
});
