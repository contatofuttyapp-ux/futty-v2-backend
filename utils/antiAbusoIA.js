// Futty v2.0 — Anti-abuso de custo da geração de avatar IA (11-ago, ordem do
// dono). Filosofia: PARAQUEDAS COM ALERTA, nunca teto de vidro — viral legítimo
// nunca é travado. Três camadas:
//   1. contador diário + teto suave (pausa só ao bater 100%, volta sozinho à
//      meia-noite — a chave é a DATA, não um estado global a limpar);
//   2. alertas em degraus (20/50/75/90%) ao super-admin, com diagnóstico
//      viral-vs-ataque calculado dos sinais disponíveis;
//   3. auto-freeze cirúrgico — só contas <48h, só sob regra de ferro (farm
//      de contas), nunca toca em quem já é da casa.
// FAIL-OPEN: se as tabelas novas ainda não existirem (migrações 045-048 por
// correr), nada aqui bloqueia uma geração — é reforço, não dependência do
// caminho feliz. O incremento do contador é read-then-write (não atómico —
// mesma tolerância já aceite pela quota mensal em avatar_ia_mes, ali perto):
// é um paraquedas de custo, não um livro-razão financeiro; uma corrida rara
// entre duas gerações simultâneas subestima o gasto em ±1, irrelevante face
// aos degraus de 20 pontos percentuais.
const crypto = require('crypto');
const { supabase } = require('./db');
const { enviarNotificacao } = require('../routes/push');

// 17-set: não há mais custo constante. O valor de cada geração vem dos headers
// da fal (`x-fal-billable-units`, ver utils/falFila.js) e chega aqui em
// `registrarGeracao({ custoCents })`. A constante antiga dizia 1,7 cêntimos; o
// real medido na bancada de 49 figurinhas é ~11,2 — a casa andou a subestimar o
// gasto diário em 6,6×, e era esse número que alimentava os alertas e o teto.
// Isto é a última linha de defesa quando a fal não manda header nenhum.
const CUSTO_FALLBACK_CENTS = 11.2;
const TETO_DIARIO_CENTS = Number(process.env.TETO_DIARIO_CENTS) || 5000; // $50/dia ≈ 446 figurinhas
const DEGRAUS = [20, 50, 75, 90];

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Gate ANTES de gastar: teto diário batido? Fail-open — nunca bloqueia por erro de infra. */
async function verificarTeto() {
  try {
    const { data } = await supabase.from('gasto_ia_diario').select('custo_cents').eq('dia', hojeISO()).maybeSingle();
    const gasto = data?.custo_cents || 0;
    return { bloqueado: gasto >= TETO_DIARIO_CENTS };
  } catch {
    return { bloqueado: false };
  }
}

/** Gate ANTES de gastar: auto-freeze activo E a conta é nova (<48h)? Fail-open. */
async function verificarFreeze(userCreatedAt) {
  try {
    const contaNova = !!userCreatedAt && Date.now() - new Date(userCreatedAt).getTime() < 48 * 3600 * 1000;
    if (!contaNova) return { congelado: false };
    const { data } = await supabase.from('app_config').select('valor').eq('chave', 'ia_freeze').maybeSingle();
    if (!data?.valor) return { congelado: false };
    let motivo = 'atividade suspeita';
    try {
      motivo = JSON.parse(data.valor).motivo || motivo;
    } catch {
      /* valor legado sem JSON — mantém o motivo genérico */
    }
    return { congelado: true, motivo };
  } catch {
    return { congelado: false };
  }
}

/** Diagnóstico viral-vs-ataque (best-effort) para o corpo do push de alerta. */
async function diagnosticar() {
  try {
    const desde24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const desde1h = new Date(Date.now() - 3600 * 1000).toISOString();

    const { data: novos } = await supabase.from('users').select('id, foto_hash').gte('created_at', desde24h);
    const idsNovos = (novos || []).map((u) => u.id);
    const total = idsNovos.length;
    if (!total) return 'INCONCLUSIVO — sem contas novas nas últimas 24h.';

    // RODADA 20 — convite virou reutilizável (migração 058): quem entrou por
    // convite agora está em convite_usos, não em convites.usado_por (que só
    // guarda o legado, de antes da mudança). A pergunta é "entrou por
    // qualquer um dos dois caminhos" — união dos ids, sem contar duas vezes.
    // Isolado num try próprio: um tropeço aqui não pode derrubar o resto do
    // diagnóstico (ataque por IP/hash), que não depende de convite nenhum.
    let idsPorConvite = new Set();
    try {
      const [{ data: usos }, { data: comConviteLegado }] = await Promise.all([
        supabase.from('convite_usos').select('user_id').in('user_id', idsNovos),
        supabase.from('convites').select('usado_por').in('usado_por', idsNovos),
      ]);
      (usos || []).forEach((u) => idsPorConvite.add(u.user_id));
      (comConviteLegado || []).forEach((c) => { if (c.usado_por) idsPorConvite.add(c.usado_por); });
    } catch {
      /* fail-safe (migração 058 por aplicar?) — pctConvite fica 0 */
    }
    const pctConvite = Math.round((idsPorConvite.size / total) * 100);

    const { data: logs1h } = await supabase.from('geracao_ia_log').select('ip').gte('created_at', desde1h);
    const ips = (logs1h || []).map((l) => l.ip).filter(Boolean);
    const ipsUnicos = new Set(ips).size;
    const contagemIp = {};
    ips.forEach((ip) => { contagemIp[ip] = (contagemIp[ip] || 0) + 1; });
    const maiorIp = Math.max(0, ...Object.values(contagemIp));

    const hashes = (novos || []).map((u) => u.foto_hash).filter(Boolean);
    const contagemHash = {};
    hashes.forEach((h) => { contagemHash[h] = (contagemHash[h] || 0) + 1; });
    const maiorHash = Math.max(0, ...Object.values(contagemHash));

    if (maiorHash >= 5 || maiorIp >= 10) {
      const causa = maiorHash >= 5 ? `${maiorHash} contas com a mesma foto` : `${maiorIp} gerações do mesmo IP`;
      return `PARECE ATAQUE — ${causa} nas últimas 24h.`;
    }
    if (pctConvite >= 40) {
      return `PARECE VIRAL — ${pctConvite}% das ${total} contas novas de hoje vieram por convite, ${ipsUnicos} IPs únicos.`;
    }
    return `INCONCLUSIVO — ${total} contas novas, ${pctConvite}% por convite, ${ipsUnicos} IPs únicos.`;
  } catch (e) {
    return `INCONCLUSIVO — diagnóstico falhou (${e.message}).`;
  }
}

/** Envia o alerta de degrau ao(s) super-admin(s) — no máximo 1x por degrau por dia. */
async function alertarSeNecessario(gastoCents) {
  try {
    const pct = Math.floor((gastoCents / TETO_DIARIO_CENTS) * 100);
    const degrau = [...DEGRAUS].reverse().find((d) => pct >= d);
    if (!degrau) return;

    const dia = hojeISO();
    const { data: linha } = await supabase.from('gasto_ia_diario').select('alertas_enviados').eq('dia', dia).maybeSingle();
    const enviados = linha?.alertas_enviados || [];
    if (enviados.includes(String(degrau))) return; // já alertou este degrau hoje

    const diagnostico = await diagnosticar();
    const { data: admins } = await supabase.from('users').select('id').eq('is_super_admin', true);
    const ids = (admins || []).map((a) => a.id);
    if (ids.length) {
      await enviarNotificacao(ids, {
        title: `IA: ${degrau}% do teto diário`,
        body: diagnostico,
        url: '/gabinete',
      });
    }
    await supabase.from('gasto_ia_diario').update({ alertas_enviados: [...enviados, String(degrau)] }).eq('dia', dia);
  } catch {
    // alerta é conforto, não obrigação — nunca deve derrubar a geração.
  }
}

/** Regra de ferro: liga o auto-freeze ao detectar farm de contas. Fail-open (nunca lança). */
async function verificarAutoFreeze() {
  try {
    const { data: jaCongelado } = await supabase.from('app_config').select('valor').eq('chave', 'ia_freeze').maybeSingle();
    if (jaCongelado?.valor) return; // já congelado — não repete

    const desde24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const desde1h = new Date(Date.now() - 3600 * 1000).toISOString();

    const { data: novos } = await supabase.from('users').select('foto_hash').gte('created_at', desde24h).not('foto_hash', 'is', null);
    const contagemHash = {};
    (novos || []).forEach((u) => { contagemHash[u.foto_hash] = (contagemHash[u.foto_hash] || 0) + 1; });
    const maiorHash = Math.max(0, ...Object.values(contagemHash));

    const { data: logs1h } = await supabase.from('geracao_ia_log').select('ip').gte('created_at', desde1h);
    const contagemIp = {};
    (logs1h || []).forEach((l) => { if (l.ip) contagemIp[l.ip] = (contagemIp[l.ip] || 0) + 1; });
    const maiorIp = Math.max(0, ...Object.values(contagemIp));

    if (maiorHash < 5 && maiorIp < 10) return;

    const motivo = maiorHash >= 5 ? `${maiorHash} contas com a mesma foto em 24h` : `${maiorIp} contas gerando do mesmo IP em 1h`;
    await supabase.from('app_config').upsert({ chave: 'ia_freeze', valor: JSON.stringify({ motivo, desde: new Date().toISOString() }), updated_at: new Date().toISOString() });

    const { data: admins } = await supabase.from('users').select('id').eq('is_super_admin', true);
    const ids = (admins || []).map((a) => a.id);
    if (ids.length) {
      await enviarNotificacao(ids, {
        title: 'IA: travei sozinha',
        body: `TRAVEI SOZINHA: ${motivo}. Libera no Gabinete.`,
        url: '/gabinete',
      });
    }
  } catch {
    // regra de ferro é rede de segurança extra — nunca deve derrubar a geração em curso.
  }
}

/**
 * Regista uma geração bem-sucedida: soma o dia, guarda o log, dispara alertas/freeze.
 * `custoCents` é o custo REAL desta geração (todas as chamadas à fal, retry
 * incluído). Vindo `null` — a fal não mandou header —, usa-se a média do dia
 * corrente, que é a melhor estimativa disponível, e só na primeira geração do
 * dia se cai no valor de referência.
 *
 * A coluna `custo_cents` é INTEGER (migração 045), por isso arredonda-se A CADA
 * geração e guarda-se a soma de inteiros: arredondar só no fim perderia os
 * cêntimos de cada linha.
 */
async function registrarGeracao({ userId, ip, custoCents = null, teamId = null }) {
  try {
    const dia = hojeISO();
    const { data: atual } = await supabase.from('gasto_ia_diario').select('geracoes, custo_cents').eq('dia', dia).maybeSingle();
    const geracoesAntes = atual?.geracoes || 0;
    const custoAntes = atual?.custo_cents || 0;
    let desta = custoCents;
    if (desta == null) {
      desta = geracoesAntes > 0 ? custoAntes / geracoesAntes : CUSTO_FALLBACK_CENTS;
      console.warn('[custo] header ausente — uso', geracoesAntes > 0 ? 'a média do dia' : 'o valor de referência', `(${desta.toFixed(1)} cents)`);
    }
    const geracoes = geracoesAntes + 1;
    const custo_cents = custoAntes + Math.round(desta);
    await supabase.from('gasto_ia_diario').upsert({ dia, geracoes, custo_cents }, { onConflict: 'dia' });
    // RODADA 28 — o log passa a guardar também o time que pagou (pacote) e o custo REAL desta geração
    // (null se a fal não mandou o header): é daqui que o Gabinete tira o custo por time POR MÊS.
    const { error: erroLog } = await supabase.from('geracao_ia_log').insert({
      user_id: userId, ip: ip || null, team_id: teamId || null, custo_cents: custoCents == null ? null : Math.round(custoCents),
    });
    if (erroLog && /team_id|custo_cents/i.test(erroLog.message || '')) {
      // Migração 063 por correr: o log de sempre (quem, IP, quando) continua — é o que o antiabuso lê.
      await supabase.from('geracao_ia_log').insert({ user_id: userId, ip: ip || null });
    }
    await alertarSeNecessario(custo_cents);
    await verificarAutoFreeze();
  } catch {
    // nunca deve derrubar a resposta ao utilizador — a figurinha já foi entregue.
  }
}

module.exports = { sha256Hex, verificarTeto, verificarFreeze, registrarGeracao };
