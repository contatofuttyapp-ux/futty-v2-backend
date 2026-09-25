// Futty v2.0 — Custo real das figurinhas por time e por mês (Rodada 28, bloco H). Puro: quem busca
// as linhas é routes/gabinete.js; aqui só se agrupa (e o teste prova a conta).

/** "AAAA-MM" no horário de Brasília — o mês do dono, não o do servidor (uma geração às 23h30 do dia 31 é do mês 31). */
function mesEmBrasilia(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formata como AAAA-MM-DD.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
}

/**
 * Linhas do log de gerações ({ team_id, custo_cents, created_at }, migração 063) → por time, os meses
 * com as gerações, o custo somado e quantas ficaram sem custo gravado (a fal não mandou o header).
 * Resultado: { [team_id]: [{ mes, geracoes, custo_usd, sem_custo }] }, mês mais recente primeiro.
 */
function custoDoTimePorMes(linhas) {
  const porTime = {};
  for (const l of linhas || []) {
    if (!l?.team_id) continue;
    const mes = mesEmBrasilia(l.created_at);
    if (!mes) continue;
    const meses = porTime[l.team_id] || (porTime[l.team_id] = {});
    const m = meses[mes] || (meses[mes] = { mes, geracoes: 0, custo_cents: 0, sem_custo: 0 });
    m.geracoes += 1;
    if (l.custo_cents == null) m.sem_custo += 1;
    else m.custo_cents += Number(l.custo_cents) || 0;
  }
  const saida = {};
  for (const [time, meses] of Object.entries(porTime)) {
    saida[time] = Object.values(meses)
      .sort((a, b) => (a.mes < b.mes ? 1 : -1))
      .map(({ mes, geracoes, custo_cents: c, sem_custo: s }) => ({ mes, geracoes, custo_usd: Number((c / 100).toFixed(2)), sem_custo: s }));
  }
  return saida;
}

module.exports = { mesEmBrasilia, custoDoTimePorMes };
