// Time de Teste "Várzea FC" — testes SEM banco (TIME-TESTE.md, parte D).
// Cobre só cálculo puro: datas (J1/J2/J3), o formato de times_resultado
// (mesma forma da rota) e o filtro do --limpar. Nada aqui toca o Supabase —
// scripts/time-teste.js só fala com o banco dentro do `if (require.main === module)`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  calcularDatas, seisQuintasAnteriores, montarResultado, eContaDoScript, eSlugDoScript, SLUG, PREFIXO, DOMINIO,
} = require('../scripts/time-teste');

// ─── Datas ───────────────────────────────────────────────────────────────
test('calcularDatas: J1 é quinta, a pelo menos 5 dias de hoje; J2 é o sábado seguinte; J3 é a terça seguinte a J2', () => {
  // Segunda-feira, 28-set-2026 (meio-dia UTC, bem longe de virada de fuso).
  const agora = new Date('2026-09-28T12:00:00Z');
  const d = calcularDatas(agora);

  assert.equal(d.j1.data.getUTCDay !== undefined, true);
  const diffDiasJ1 = Math.floor((Date.UTC(d.j1.ymd.ano, d.j1.ymd.mes - 1, d.j1.ymd.dia) - Date.UTC(2026, 8, 28)) / 86400000);
  assert.ok(diffDiasJ1 >= 5, `J1 devia estar a pelo menos 5 dias de hoje, deu ${diffDiasJ1}`);
  assert.equal(new Date(Date.UTC(d.j1.ymd.ano, d.j1.ymd.mes - 1, d.j1.ymd.dia)).getUTCDay(), 4, 'J1 tem de ser quinta-feira');
  assert.equal(new Date(Date.UTC(d.j2.ymd.ano, d.j2.ymd.mes - 1, d.j2.ymd.dia)).getUTCDay(), 6, 'J2 tem de ser sábado');
  assert.equal(new Date(Date.UTC(d.j3.ymd.ano, d.j3.ymd.mes - 1, d.j3.ymd.dia)).getUTCDay(), 2, 'J3 tem de ser terça-feira');

  assert.ok(d.j2.data.getTime() > d.j1.data.getTime(), 'J2 tem de vir depois de J1');
  assert.ok(d.j3.data.getTime() > d.j2.data.getTime(), 'J3 tem de vir depois de J2');
  assert.ok(d.rsvpPrazo.getTime() < d.j1.data.getTime(), 'o prazo do RSVP tem de ser antes de J1');

  // Horários (Brasília): J1 20h, J2 9h, J3 21h.
  const partesJ1 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(d.j1.data);
  const partesJ2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(d.j2.data);
  const partesJ3 = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(d.j3.data);
  assert.equal(partesJ1, '20', `J1 devia ser 20h, deu ${partesJ1}h`);
  assert.equal(partesJ2, '09', `J2 devia ser 9h, deu ${partesJ2}h`);
  assert.equal(partesJ3, '21', `J3 devia ser 21h, deu ${partesJ3}h`);
});

test('calcularDatas: J1 nunca fica a menos de 5 dias, qualquer que seja o dia da semana de hoje', () => {
  for (let dia = 0; dia < 7; dia += 1) {
    const agora = new Date(Date.UTC(2026, 9, 1 + dia, 15, 0, 0)); // 01 a 07-out-2026 (varre a semana toda)
    const d = calcularDatas(agora);
    const hojeYMD = { ano: agora.getUTCFullYear(), mes: agora.getUTCMonth() + 1, dia: agora.getUTCDate() };
    const diff = Math.round((Date.UTC(d.j1.ymd.ano, d.j1.ymd.mes - 1, d.j1.ymd.dia) - Date.UTC(hojeYMD.ano, hojeYMD.mes - 1, hojeYMD.dia)) / 86400000);
    assert.ok(diff >= 5, `dia-base ${agora.toISOString()}: J1 a só ${diff} dia(s)`);
  }
});

test('calcularDatas: atravessa virada de mês sem quebrar (fim de outubro/2026)', () => {
  const agora = new Date('2026-10-29T12:00:00Z'); // quinta-feira
  const d = calcularDatas(agora);
  assert.ok(d.j1.ymd.mes === 11 || (d.j1.ymd.mes === 10 && d.j1.ymd.dia > 29), 'J1 tem de cair depois de 29-out (mesmo virando novembro)');
  assert.equal(new Date(Date.UTC(d.j3.ymd.ano, d.j3.ymd.mes - 1, d.j3.ymd.dia)).getUTCDay(), 2);
});

test('seisQuintasAnteriores: 6 quintas em ordem crescente, todas antes de hoje, espaçadas 7 dias', () => {
  const agora = new Date('2026-09-28T12:00:00Z');
  const seis = seisQuintasAnteriores(agora);
  assert.equal(seis.length, 6);
  seis.forEach((q) => {
    assert.equal(new Date(Date.UTC(q.ymd.ano, q.ymd.mes - 1, q.ymd.dia)).getUTCDay(), 4);
    assert.ok(q.data.getTime() < agora.getTime());
  });
  for (let i = 1; i < seis.length; i += 1) {
    const diff = (Date.UTC(seis[i].ymd.ano, seis[i].ymd.mes - 1, seis[i].ymd.dia) - Date.UTC(seis[i - 1].ymd.ano, seis[i - 1].ymd.mes - 1, seis[i - 1].ymd.dia)) / 86400000;
    assert.equal(diff, 7, `quintas ${i - 1} e ${i} deviam estar 7 dias uma da outra`);
  }
});

// ─── Formato de times_resultado (mesma forma da rota, routes/games.js) ────
test('montarResultado: mesmas chaves e tipos que a rota grava em times_resultado', () => {
  const sorteioFalso = {
    numTimes: 2,
    times: [
      [{ user_id: 'a', nome: 'A', rating: 4, goleiro: true, cabeca_chave: false, avatar_url: null }],
      [{ user_id: 'b', nome: 'B', rating: 3, goleiro: false, cabeca_chave: true, avatar_url: null }],
    ],
    reservas: [{ posicao: 1, user_id: 'c', nome: 'C', rating: 2, avatar_url: null }],
    seed: 1234,
  };
  const r = montarResultado(sorteioFalso, 3, 1);
  assert.equal(r.num_times, 2);
  assert.equal(r.total_jogadores, 3);
  assert.equal(r.convidados_total, 1);
  assert.equal(r.seed, 1234);
  assert.ok(Number.isInteger(r.seed), 'seed tem de ser inteiro');
  assert.deepEqual(Array.isArray(r.avisos), true);
  assert.equal(r.times.length, 2);
  assert.equal(r.times[0].nome, 'Time A');
  assert.equal(r.times[1].nome, 'Time B');
  assert.equal(typeof r.times[0].rating_medio, 'number');
  assert.deepEqual(Object.keys(r).sort(), ['avisos', 'convidados_total', 'num_times', 'reservas', 'seed', 'times', 'total_jogadores'].sort());
  assert.equal(r.reservas, sorteioFalso.reservas);
});

// ─── Filtro do --limpar ─────────────────────────────────────────────────
test('eContaDoScript: só casa teste-varzea-…@futtymock.com (com hífen)', () => {
  assert.equal(eContaDoScript(`${PREFIXO}-tonhao${DOMINIO}`), true);
  assert.equal(eContaDoScript('teste-varzeaX@futtymock.com'), false, 'sem o hífen não é conta do script');
  assert.equal(eContaDoScript('demo-loja@futtymock.com'), false);
  assert.equal(eContaDoScript('teste-varzea-tonhao@gmail.com'), false, 'domínio errado');
  assert.equal(eContaDoScript('contatofuttyapp@gmail.com'), false);
  assert.equal(eContaDoScript(null), false);
});

test('eSlugDoScript: só o slug exato varzea-fc-teste', () => {
  assert.equal(eSlugDoScript(SLUG), true);
  assert.equal(eSlugDoScript('varzea-fc-teste-2'), false);
  assert.equal(eSlugDoScript('domingueira-fc-demo'), false);
  assert.equal(eSlugDoScript(''), false);
});
