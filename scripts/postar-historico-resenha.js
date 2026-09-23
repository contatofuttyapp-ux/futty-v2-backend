// Futty v2.0 — HISTÓRICO DA MISSA DE QUINTA NA RESENHA (23-set).
//
// Publica, com data retroativa, as fotos de "TIME CAMPEÃO" (uma por dia de
// jogo) como posts da Resenha do time "Missa de Quinta". Mesma compressão do
// upload normal (routes/feed.js: sharp 1600px, WebP q80), mesmo bucket
// (resenha), mesma cota (migração 053). Sem IA, custo US$0.
//
// IDEMPOTENTE: a legenda de cada post ("🏆 Time campeão · DD/MM/AAAA", ou a
// do 1º campeonato) é a marca — reexecutar pula quem já foi publicado.
//
// Uso (a partir de backend/):
//   node scripts/postar-historico-resenha.js                 simulação (não grava nada)
//   node scripts/postar-historico-resenha.js --confirmo       publica de verdade
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { supabase } = require('../utils/db');

const CONFIRMO = process.argv.includes('--confirmo');
const PASTA_FOTOS = 'C:\\Users\\phfer\\Desktop\\FUT\\TIME CAMPEÃO';
const NOME_TIME = 'Missa de Quinta';
const EMAIL_DONO = 'contatofuttyapp@gmail.com';
const STORAGE_BUCKET = 'resenha';
// Mesma receita de routes/feed.js (Rodada 15) — não duplicar a constante, copiar o valor.
const COMPRESSAO_LADO_MAX = 1600;
const COMPRESSAO_QUALIDADE = 80;
const DATA_PRIMEIRO_CAMPEONATO = '19/06/2026';

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const aviso = (m) => console.warn('!', m);

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** "DD MM AA.jpeg" (dia/mês sem zero à esquerda aceitos) → {dia, mes, ano, iso}. null se não der para interpretar. */
function interpretarNomeArquivo(nomeArquivo) {
  const m = nomeArquivo.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{2})\.jpe?g$/i);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = 2000 + Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  // Round-trip: confirma que é uma data real (ex.: 31/04 não existe).
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return { dia, mes, ano, dataFmt: `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}` };
}

/** Offset (minutos) de Europe/Lisbon no instante `d` (0 no inverno/WET, 60 no verão/WEST). */
function offsetLisboaMin(d) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Lisbon', timeZoneName: 'shortOffset' }).formatToParts(d);
  const tz = partes.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
  const m = tz.match(/GMT([+-]\d+)?/);
  return (m && m[1] ? parseInt(m[1], 10) : 0) * 60;
}

/** 22:00 de Lisboa no dia dado → Date UTC correto (considera DST). */
function as22hLisboa(ano, mes, dia) {
  const aproximado = new Date(Date.UTC(ano, mes - 1, dia, 22, 0, 0));
  const offsetMin = offsetLisboaMin(aproximado);
  return new Date(Date.UTC(ano, mes - 1, dia, 22, 0, 0) - offsetMin * 60000);
}

function legendaDe(dataFmt) {
  return dataFmt === DATA_PRIMEIRO_CAMPEONATO
    ? `🏆 Primeiro campeonato da Missa de Quinta · ${dataFmt}`
    : `🏆 Time campeão · ${dataFmt}`;
}

/** Mesma função de routes/feed.js (comprimirImagem) — igual, não importada (script não depende da rota). */
async function comprimirImagem(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(COMPRESSAO_LADO_MAX, COMPRESSAO_LADO_MAX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: COMPRESSAO_QUALIDADE })
    .toBuffer();
}

async function main() {
  console.log(`[historico] ${CONFIRMO ? 'EXECUÇÃO' : 'SIMULAÇÃO (nada será gravado — rode com --confirmo para valer)'}\n`);

  // 1. Fotos, em ordem cronológica — puramente do disco, não depende do time existir.
  const arquivos = fs.readdirSync(PASTA_FOTOS).filter((f) => /\.jpe?g$/i.test(f));
  const invalidos = [];
  const itens = [];
  for (const arq of arquivos) {
    const interpretado = interpretarNomeArquivo(arq);
    if (!interpretado) { invalidos.push(arq); continue; }
    itens.push({ arquivo: arq, ...interpretado });
  }
  itens.sort((a, b) => a.ano - b.ano || a.mes - b.mes || a.dia - b.dia);
  info(`${itens.length} foto(s) reconhecida(s) de ${arquivos.length} arquivo(s) na pasta.`);
  if (invalidos.length) aviso(`arquivo(s) que não deu para interpretar: ${invalidos.join(', ')}`);

  // 2. Time (produção, mesmo Supabase) — nome exato, sem diferenciar acento/maiúsculas.
  const { data: times, error: eTimes } = await supabase.from('teams').select('id, nome, slug');
  if (eTimes) throw new Error(`teams: ${eTimes.message}`);
  const alvo = normalizar(NOME_TIME);
  const time = (times || []).find((t) => normalizar(t.nome) === alvo);
  if (!time) {
    console.log('\nPrévia do que SERIA publicado (compressão real, só para conferência — nada gravado):');
    console.log('arquivo'.padEnd(18) + 'data'.padEnd(13) + 'legenda'.padEnd(58) + 'bytes (webp)');
    for (const it of itens) {
      const legenda = legendaDe(it.dataFmt);
      // eslint-disable-next-line no-await-in-loop
      const bytes = (await comprimirImagem(fs.readFileSync(path.join(PASTA_FOTOS, it.arquivo)))).length;
      console.log(it.arquivo.padEnd(18) + it.dataFmt.padEnd(13) + legenda.padEnd(58) + String(bytes));
    }
    console.error(`\n[historico] Time "${NOME_TIME}" não existe no banco (${times.length} time(s) no total: ${times.map((t) => t.nome).join(', ') || '—'}).`);
    console.error('[historico] PARADO — o Pedro precisa criar o time "Missa de Quinta" no app antes de rodar isto. Nada foi gravado.');
    process.exitCode = 1;
    return;
  }
  ok(`time "${time.nome}" encontrado (${time.slug}, ${time.id}).`);

  // Autor: o dono.
  const { data: dono, error: eDono } = await supabase.from('users').select('id, email').eq('email', EMAIL_DONO).maybeSingle();
  if (eDono || !dono) throw new Error(`autor ${EMAIL_DONO} não encontrado: ${eDono?.message || 'sem linha'}`);

  // Idempotência: legendas já publicadas por este autor, neste time.
  const legendas = itens.map((it) => legendaDe(it.dataFmt));
  const { data: existentes, error: eExist } = await supabase
    .from('feed_posts').select('body').eq('team_id', time.id).eq('author_id', dono.id).in('body', legendas);
  if (eExist) throw new Error(`feed_posts (checar existentes): ${eExist.message}`);
  const jaPublicadas = new Set((existentes || []).map((p) => p.body));

  const linhasRelatorio = [];
  let bytesTotalNovo = 0;

  for (const it of itens) {
    const legenda = legendaDe(it.dataFmt);
    if (jaPublicadas.has(legenda)) {
      linhasRelatorio.push({ arquivo: it.arquivo, data: it.dataFmt, legenda, bytes: '—', status: 'já existia (pulado)' });
      continue;
    }

    const caminhoCompleto = path.join(PASTA_FOTOS, it.arquivo);
    const bufferOriginal = fs.readFileSync(caminhoCompleto);
    // eslint-disable-next-line no-await-in-loop
    const bufferComprimido = await comprimirImagem(bufferOriginal);
    const bytes = bufferComprimido.length;
    bytesTotalNovo += bytes;

    if (!CONFIRMO) {
      linhasRelatorio.push({ arquivo: it.arquivo, data: it.dataFmt, legenda, bytes, status: 'simulado' });
      continue;
    }

    const nomeStorage = `${crypto.randomUUID()}.webp`;
    // eslint-disable-next-line no-await-in-loop
    const { error: eUp } = await supabase.storage.from(STORAGE_BUCKET).upload(nomeStorage, bufferComprimido, { contentType: 'image/webp', upsert: false });
    if (eUp) throw new Error(`upload ${it.arquivo}: ${eUp.message}`);
    const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(nomeStorage);

    const dataHora = as22hLisboa(it.ano, it.mes, it.dia).toISOString();
    // eslint-disable-next-line no-await-in-loop
    const { data: post, error: ePost } = await supabase
      .from('feed_posts')
      .insert({ team_id: time.id, author_id: dono.id, body: legenda, created_at: dataHora, updated_at: dataHora })
      .select().single();
    if (ePost) throw new Error(`feed_posts ${it.arquivo}: ${ePost.message}`);

    // eslint-disable-next-line no-await-in-loop
    const { error: eMedia } = await supabase.from('feed_post_media').insert({
      post_id: post.id, url: pub.publicUrl, media_type: 'image', position: 0, bytes, created_at: dataHora,
    });
    if (eMedia) throw new Error(`feed_post_media ${it.arquivo}: ${eMedia.message}`);

    linhasRelatorio.push({ arquivo: it.arquivo, data: it.dataFmt, legenda, bytes, status: 'publicado' });
  }

  console.log('\narquivo'.padEnd(18) + 'data'.padEnd(13) + 'legenda'.padEnd(58) + 'bytes'.padEnd(10) + 'status');
  for (const l of linhasRelatorio) {
    console.log(l.arquivo.padEnd(18) + l.data.padEnd(13) + l.legenda.padEnd(58) + String(l.bytes).padEnd(10) + l.status);
  }

  if (CONFIRMO) {
    const { data: totalCota, error: eCota } = await supabase.rpc('feed_bytes_por_time', { p_team_id: time.id });
    if (eCota) aviso(`não consegui ler a cota via RPC (migração 053?): ${eCota.message}`);
    else ok(`cota do time (feed_bytes_por_time) agora: ${totalCota} bytes (${(totalCota / (1024 * 1024)).toFixed(2)} MB) de 500 MB.`);
  } else {
    info(`bytes que SERIAM gravados nesta rodada: ${bytesTotalNovo} (${(bytesTotalNovo / (1024 * 1024)).toFixed(2)} MB) — rode com --confirmo para publicar de verdade.`);
  }

  if (invalidos.length) aviso(`lembrete: ${invalidos.length} arquivo(s) ficaram de fora por nome não reconhecido — ver lista acima.`);
  info('nada foi apagado de TIME CAMPEÃO (a pasta permanece intacta).');
}

main().catch((e) => { console.error('[historico] ERRO:', e.message); process.exit(1); });
