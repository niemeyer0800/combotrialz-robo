// ComboTrialz · robô que roda sozinho no GitHub Actions (grátis), sem ninguém online.
//
// A cada execução:
//   1. verifica as notícias "pendente" com mais de 5 min (Gemini + Google Search) e publica ou descarta;
//   2. a cada 30 min, pesquisa notícias novas e grava como "pendente";
//   3. confere os canais do YouTube cadastrados (ytCanais) e acha vídeos novos;
//   4. importa os relatórios de combos do Claude que chegarem em relatorios/*.json;
//   5. grava estado/estado.json (o que já existe na base) para a pesquisa do Claude não repetir;
//   6. manda push para os aparelhos em pushTokens (notícias, combos e vídeos novos).
// As notícias publicadas entram direto na coleção "news" (aba Cenário do app).
//
// Segredos (GitHub → Settings → Secrets and variables → Actions):
//   GEMINI_API_KEY            chave do Gemini (AI Studio)
//   FIREBASE_SERVICE_ACCOUNT  conteúdo do .json da conta de serviço do Firebase
//
// Usa os mesmos documentos do painel de admin do app (config/newsState, config/ytState),
// então app e robô não repetem trabalho nem mandam aviso duas vezes.
import crypto from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { importarRelatorio, idNoticiaUrl, dominio as dominioNoticia, TIPOS_NOTICIA } from './importar.mjs';
import { coletar, triar } from './noticias-rss.mjs';

const MODELO = process.env.GEMINI_MODELO || 'gemini-2.5-flash';
const RESERVAS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite'];
// o plano grátis do Gemini dá ~20 pedidos/dia por modelo: busca a cada 3 h + 1 verificação em lote = ~16/dia
const INTERVALO_NOTICIAS_MS = (Number(process.env.HORAS_ENTRE_BUSCAS) || 3) * 60 * 60 * 1000;
const INTERVALO_VIDEOS_MS = 4 * 60 * 1000;           // o workflow roda a cada 5 min
const ESTADO_MAX_MS = 6 * 60 * 60 * 1000;             // estado.json: regera se algo mudou ou a cada 6 h
const ESPERA_VERIFICACAO_MS = 5 * 60 * 1000;
const TOLERANCIA_DIAS = 1;
const LINK_NOVIDADES = './#/novidades';
const JOGOS = ['Street Fighter 6', 'Tekken 8', 'Fatal Fury: City of the Wolves', 'Mortal Kombat',
  'Guilty Gear Strive', '2XKO', 'Marvel Tokon', 'Virtua Fighter', 'Granblue Fantasy Versus'];

// ---------- utilidades (iguais às do app) ----------
export const hojeSP = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const dataEhRecente = (d, hoje) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= somarDias(hoje, -TOLERANCIA_DIAS) && d <= somarDias(hoje, 1);
const dominio = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'fonte'; } };
const millis = ts => ts?.toMillis ? ts.toMillis() : ts ? Date.parse(ts) : 0;

function promptBusca(hoje) {
  return `Hoje é ${hoje} (horário de Brasília).

Pesquise no Google notícias de fighting games publicadas em ${hoje} ou ${somarDias(hoje, -1)}.
Foque em: ${JOGOS.join(', ')} e outros jogos de luta relevantes.
Tipos de notícia: patches e balanceamento, novos personagens/DLC, anúncios, resultados de torneios (Capcom Pro Tour, EVO, etc.).

Regras:
- Use SOMENTE o que encontrar na busca. Não use conhecimento prévio.
- Ignore qualquer notícia publicada antes de ${somarDias(hoje, -1)}.
- A data é a da publicação ORIGINAL da notícia, não a data em que alguém repostou.
- Escreva em português do Brasil.
- Responda SOMENTE com linhas neste formato, uma notícia por linha, sem nada antes ou depois:
NOTICIA|AAAA-MM-DD|tipo|Título curto|Resumo em uma ou duas frases
  (tipo é um destes: torneio, patch, personagem, combo, cenario, comunidade)
- Se não encontrar nada novo, responda apenas: NENHUMA`;
}
function promptVerificacaoLote(hoje, lista) {
  return `Hoje é ${hoje} (horário de Brasília).

Verifique pesquisando no Google se cada notícia de fighting game abaixo é REAL e em que data foi publicada originalmente.
Considere falsa se não encontrar confirmação em fonte confiável, se for boato não confirmado,
ou se for notícia antiga sendo repercutida agora.

${lista.map((n, i) => `${i + 1}) Título: ${n.titulo}
   Resumo: ${n.resumo}
   Data informada: ${n.dataPublicacao}
   Fontes: ${(n.fontes || []).map(f => f.url).join(', ')}`).join('\n\n')}

Responda SOMENTE com um JSON (lista), um item por notícia, sem texto extra:
[{"n": 1, "real": true ou false, "data_publicacao": "AAAA-MM-DD" ou null, "motivo": "explicação curta"}]`;
}
export function parseVereditos(texto) {
  const m = (texto || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    const out = new Map();
    for (const j of arr) if (Number.isInteger(j.n)) out.set(j.n, { real: j.real === true,
      dataPublicacao: typeof j.data_publicacao === 'string' ? j.data_publicacao : null, motivo: String(j.motivo ?? '') });
    return out;
  } catch { return null; }
}
function promptVerificacao(hoje, n) {
  return `Hoje é ${hoje} (horário de Brasília).

Verifique pesquisando no Google se esta notícia de fighting game é REAL e em que data foi publicada originalmente.

Título: ${n.titulo}
Resumo: ${n.resumo}
Data informada: ${n.dataPublicacao}
Fontes citadas: ${(n.fontes || []).map(f => f.url).join(', ')}

Considere falsa se não encontrar confirmação em fonte confiável, se for boato não confirmado,
ou se for notícia antiga sendo repercutida agora.

Responda SOMENTE com JSON, sem texto extra:
{"real": true ou false, "data_publicacao": "AAAA-MM-DD" ou null, "motivo": "explicação curta"}`;
}

// ---------- Gemini ----------
export async function gemini(apiKey, prompt, modelo = MODELO) {
  let erro;
  for (const m of [...new Set([modelo, ...RESERVAS])]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return extrairResposta(j);
    erro = new Error(`Gemini (${m}) ${r.status}: ${j.error?.message || 'erro'}`);
    if (![404, 429, 500, 503].includes(r.status)) throw erro;
  }
  throw erro;
}
// texto + citações (posições do Gemini vêm em bytes UTF-8; aqui viram caracteres)
export function extrairResposta(j) {
  const cand = j.candidates?.[0] || {};
  const texto = (cand.content?.parts || []).map(p => p.text || '').join('');
  const gm = cand.groundingMetadata || {};
  const queries = gm.webSearchQueries || [];
  const bytes = Buffer.from(texto, 'utf8');
  const ch = i => bytes.subarray(0, i).toString('utf8').length;
  const chunks = gm.groundingChunks || [], citacoes = [];
  for (const s of gm.groundingSupports || []) {
    for (const k of s.groundingChunkIndices || []) {
      const w = chunks[k]?.web;
      if (!w?.uri) continue;
      citacoes.push({ url: w.uri, titulo: w.title || dominio(w.uri), inicio: ch(s.segment?.startIndex || 0), fim: ch(s.segment?.endIndex || 0) });
    }
  }
  return { pesquisou: queries.length > 0, queries, texto, citacoes };
}
export function parseNoticias(texto, citacoes) {
  const noticias = [];
  let pos = 0;
  for (const linha of texto.split('\n')) {
    const inicioLinha = pos; pos += linha.length + 1;
    const m = linha.match(/^\s*NOTICIA\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|(?:\s*(torneio|patch|personagem|combo|cenario|comunidade)\s*\|)?([^|]+)\|(.+)$/i);
    if (!m) continue;
    const [, data, tipoBruto, tituloBruto, resumoBruto] = m;
    const kind = TIPOS_NOTICIA.includes((tipoBruto || '').toLowerCase()) ? tipoBruto.toLowerCase() : 'cenario';
    const inicioResumo = inicioLinha + linha.lastIndexOf(resumoBruto), fimResumo = inicioResumo + resumoBruto.length;
    const daLinha = citacoes.filter(c => c.inicio < inicioLinha + linha.length && c.fim > inicioLinha);
    if (!daLinha.length) continue;                       // sem fonte = descarta
    const porPosicao = new Map();
    for (const c of daLinha) {
      const p = Math.min(Math.max(c.fim, inicioResumo), fimResumo) - inicioResumo;
      if (!porPosicao.has(p)) porPosicao.set(p, []);
      const l = porPosicao.get(p); if (!l.some(x => x.url === c.url)) l.push(c);
    }
    let resumoComFontes = resumoBruto;
    for (const p of [...porPosicao.keys()].sort((a, b) => b - a)) {
      const links = porPosicao.get(p).map(c => `[${c.titulo}](${c.url})`).join(' ');
      resumoComFontes = resumoComFontes.slice(0, p) + ` ${links}` + resumoComFontes.slice(p);
    }
    const fontes = [];
    for (const c of daLinha) if (!fontes.some(f => f.url === c.url)) fontes.push({ url: c.url, titulo: c.titulo });
    noticias.push({ dataPublicacao: data, kind, titulo: tituloBruto.trim(), resumo: resumoBruto.trim(),
      resumoComFontes: resumoComFontes.trim().replace(/\s+([.,;!?])/g, '$1'), fontes });
  }
  return noticias;
}
// mesmo ID que o app gera (título normalizado + data), para não duplicar
export function idNoticia(n) {
  const chave = `${n.dataPublicacao}|${n.titulo.toLowerCase().normalize('NFD').replace(/[^\w ]+/g, '').replace(/\s+/g, ' ').trim()}`;
  return crypto.createHash('sha1').update(chave).digest('hex').slice(0, 20);
}
export function parseVeredito(texto) {
  const m = (texto || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { real: j.real === true, dataPublicacao: typeof j.data_publicacao === 'string' ? j.data_publicacao : null, motivo: String(j.motivo ?? '') };
  } catch { return null; }
}

// ---------- YouTube (feed público, sem chave) ----------
const entidades = s => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }[e]));
export async function feedYoutube(canalId) {
  // o feed do YouTube oscila entre 404 e 200: tenta algumas vezes antes de desistir
  let r;
  for (let i = 0; i < 4; i++) {
    r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${canalId}`, { headers: { 'User-Agent': 'Mozilla/5.0 (ComboTrialz)' } }).catch(() => null);
    if (r && r.ok) break;
    await new Promise(ok => setTimeout(ok, 1500 * (i + 1)));
  }
  if (!r || !r.ok) throw new Error(`feed ${canalId}: ${r ? r.status : 'sem resposta'}`);
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1],
    titulo: entidades((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''),
    publicado: (e.match(/<published>([^<]+)<\/published>/) || [])[1] || '',
  })).filter(v => v.id);
}

// ---------- push ----------
async function enviarPush(db, avisos) {
  if (!avisos.length) return 0;
  const snap = await db.collection('pushTokens').get();
  const tokens = snap.docs.map(d => ({ ref: d.ref, token: d.data().token || d.id }));
  if (!tokens.length) return 0;
  let entregues = 0;
  for (const a of avisos) {
    for (let i = 0; i < tokens.length; i += 500) {
      const lote = tokens.slice(i, i + 500);
      const res = await getMessaging().sendEach(lote.map(t => ({
        token: t.token, data: { title: a.title, body: a.body, link: a.link },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      })));
      entregues += res.successCount;
      await Promise.all(res.responses.map((r, k) => {
        const code = r.error?.code || '';
        return /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code) ? lote[k].ref.delete().catch(() => {}) : null;
      }));
    }
  }
  return entregues;
}

// ---------- notícias ----------
async function noticias(db, apiKey) {
  const agora = Date.now(), hoje = hojeSP();
  const estRef = db.doc('config/newsState');
  const est = (await estRef.get()).data() || {};
  const col = db.collection('noticias');
  const pend = (await col.where('status', '==', 'pendente').limit(10).get()).docs
    .filter(d => agora - millis(d.data().criadaEm) >= ESPERA_VERIFICACAO_MS);
  const buscar = agora - millis(est.ultimaBusca) >= INTERVALO_NOTICIAS_MS;
  if (!buscar && !pend.length) { await estRef.set({ roboEm: FieldValue.serverTimestamp() }, { merge: true }); return { log: 'notícias: nada a fazer', publicadas: [] }; }
  if (agora - millis(est.rodandoDesde) < 4 * 60 * 1000) return { log: 'notícias: outra execução em andamento', publicadas: [] };
  await estRef.set({ rodandoDesde: FieldValue.serverTimestamp(), rodandoPor: 'github', roboEm: FieldValue.serverTimestamp() }, { merge: true });

  const publicadas = [];
  let descartadas = 0, novas = 0;
  try {
    // todas as pendentes num pedido só (economiza a cota do Gemini)
    let rv = null, vs = null;
    if (pend.length) {
      try { rv = await gemini(apiKey, promptVerificacaoLote(hoje, pend.map(d => d.data()))); vs = parseVereditos(rv.texto); }
      catch (e) { console.warn('verificação falhou:', e.message); }
    }
    for (const [i, d] of (rv ? pend : []).entries()) {
      const n = d.data(), r = rv, v = vs ? vs.get(i + 1) || null : null;
      let motivo = null;
      if (!r.pesquisou) motivo = 'verificação sem busca no Google';
      else if (!v) motivo = 'resposta de verificação ilegível';
      else if (!v.real) motivo = `não confirmada: ${v.motivo}`;
      else if (!dataEhRecente(v.dataPublicacao, hoje)) motivo = `notícia antiga (publicada em ${v.dataPublicacao ?? 'data desconhecida'})`;
      await d.ref.update({
        status: motivo ? 'descartada' : 'publicada', motivoDescarte: motivo,
        dataPublicacao: v?.dataPublicacao && !motivo ? v.dataPublicacao : n.dataPublicacao,
        verificacao: { real: v?.real ?? null, dataConfirmada: v?.dataPublicacao ?? null, motivo: v?.motivo ?? null,
          queries: r.queries, fontesVerificacao: r.citacoes.map(c => c.url), verificadaEm: FieldValue.serverTimestamp(), por: 'github' },
      });
      if (motivo) descartadas++;
      else if (await publicarNoCenario(db, { ...n, dataPublicacao: v?.dataPublicacao || n.dataPublicacao }, hoje)) publicadas.push(n.titulo);
    }
    if (buscar) {
      const r = await gemini(apiKey, promptBusca(hoje));
      if (r.pesquisou && !/^\s*NENHUMA\s*$/i.test(r.texto)) {
        for (const n of parseNoticias(r.texto, r.citacoes)) {
          if (!dataEhRecente(n.dataPublicacao, hoje)) continue;
          const ref = col.doc(idNoticia(n));
          try { await ref.create({ ...n, status: 'pendente', buscaQueries: r.queries, criadaEm: FieldValue.serverTimestamp() }); novas++; }
          catch (e) { if (e.code !== 6) throw e; }            // 6 = já existe
        }
      }
      await estRef.set({ ultimaBusca: FieldValue.serverTimestamp() }, { merge: true });
    }
  } finally {
    await estRef.set({ rodandoDesde: null, ultimoResumo: `${novas} nova(s), ${publicadas.length} publicada(s), ${descartadas} descartada(s) · robô` }, { merge: true });
  }
  return { log: `notícias: ${novas} nova(s), ${publicadas.length} publicada(s), ${descartadas} descartada(s)`, publicadas };
}

// ---------- vídeos ----------
async function videos(db) {
  const estRef = db.doc('config/ytState');
  const est = (await estRef.get()).data() || {};
  if (Date.now() - millis(est.ultimaChecagem) < INTERVALO_VIDEOS_MS) return { log: 'vídeos: conferido há pouco', novos: [] };
  await estRef.set({ ultimaChecagem: FieldValue.serverTimestamp(), por: 'github' }, { merge: true });
  const novos = [];
  for (const d of (await db.collection('ytCanais').get()).docs) {
    const c = d.data();
    let vs;
    try { vs = await feedYoutube(d.id); } catch (e) { console.warn(e.message); continue; }
    const recentes = vs.filter(v => v.publicado > (c.ultimoVideoEm || ''));
    if (!recentes.length) continue;
    await d.ref.update({ ultimoVideoEm: recentes.map(v => v.publicado).sort().pop() });
    for (const v of recentes) novos.push({ ...v, canal: c.titulo || d.id });
  }
  return { log: `vídeos: ${novos.length} novo(s)`, novos };
}


// ---------- notícias do Gemini no Cenário (coleção "news") ----------
// O link do Google (vertexaisearch...) é trocado pelo endereço real da matéria.
async function linkReal(url) {
  if (!/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/.test(url)) return url;
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return r.headers.get('location') || url;
  } catch { return url; }
}
const isoSP = () => {
  const d = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19);
  return `${d}-03:00`;
};
async function publicarNoCenario(db, n, hoje) {
  const url = await linkReal(n.fontes?.[0]?.url || '');
  if (!/^https?:\/\//.test(url)) return false;
  const ref = db.doc(`news/${idNoticiaUrl(url)}`), atual = await ref.get();
  if (atual.exists) return false;                       // já publicada (pelo Claude ou antes)
  await ref.set({ id: ref.id, title: n.titulo, url, source: dominioNoticia(url), publishedAt: n.dataPublicacao,
    summary: n.resumo, kind: n.kind || 'cenario', characterIds: [], createdAt: isoSP(), runId: `${hoje}-gemini` });
  return true;
}

// ---------- relatórios de combos do Claude (relatorios/*.json) ----------
async function relatorios(db) {
  let arquivos = [];
  try { arquivos = (await readdir('relatorios')).filter(f => f.endsWith('.json')).sort(); } catch { return { log: 'relatórios: pasta vazia', combos: [], noticias: [] }; }
  const reg = db.doc('config/relatoriosImportados');
  const feitos = (await reg.get()).data()?.arquivos || {};
  const combos = [], noticias = [], log = [];
  for (const f of arquivos) {
    const chave = f.replace(/\./g, '_');
    if (feitos[chave]) continue;
    try {
      const r = await importarRelatorio(db, JSON.parse(await readFile(`relatorios/${f}`, 'utf8')));
      combos.push(...r.novosCombos); noticias.push(...r.novasNoticias);
      log.push(`${f}: ${r.added} combo(s) novo(s), ${r.updated} atualizado(s), ${r.novasNoticias.length} notícia(s)${r.erros.length ? `; avisos: ${r.erros.join(' ')}` : ''}`);
      await reg.set({ arquivos: { [chave]: { em: FieldValue.serverTimestamp(), combos: r.added, atualizados: r.updated } } }, { merge: true });
    } catch (e) { log.push(`${f}: ERRO ${e.message}`); process.exitCode = 1; }
  }
  return { log: log.length ? `relatórios: ${log.join(' | ')}` : 'relatórios: nada novo', combos, noticias };
}

// ---------- estado da base para a pesquisa do Claude ----------
async function exportarEstado(db) {
  const meta = (await db.doc('meta/game').get()).data() || {};
  const combos = (await db.collection('combos').get()).docs.map(d => d.data())
    .map(c => ({ id: c.id, characterId: c.characterId, controls: c.controls, notation: c.notation, status: c.status }))
    .sort((a, b) => (a.characterId + a.controls + a.notation).localeCompare(b.characterId + b.controls + b.notation));
  const noticias = (await db.collection('news').get()).docs.map(d => d.data())
    .map(n => ({ url: n.url, title: n.title, publishedAt: n.publishedAt || null, removed: !!n.removed }))
    .filter(n => n.url).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, 300);
  const estado = { explicacao: 'Gerado pelo robô a cada execução. Use para não repetir combos e notícias. Notícia com removed=true foi derrubada pela comunidade: nunca republique.',
    balancePatch: meta.balancePatch || null, combos, noticias };
  await mkdir('estado', { recursive: true });
  await writeFile('estado/estado.json', JSON.stringify(estado, null, 1) + '\n');
  return `estado: ${combos.length} combos, ${noticias.length} notícias`;
}

// ---------- execução ----------
async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!sa?.private_key) throw new Error('Falta o segredo FIREBASE_SERVICE_ACCOUNT.');
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();
  const avisos = [];
  let mudou = false;

  try {
    const r = await relatorios(db);
    console.log(r.log);
    if (/combo|notícia/.test(r.log) && !/nada novo/.test(r.log)) mudou = true;
    if (r.combos.length) {
      const nomes = [...new Set(r.combos.map(c => c.characterId))].slice(0, 4).join(', ');
      avisos.push({ title: r.combos.length === 1 ? 'Combo novo no ComboTrialz' : `${r.combos.length} combos novos no ComboTrialz`,
        body: r.combos.length === 1 ? `${r.combos[0].characterId}: ${r.combos[0].title || r.combos[0].notation}` : `Para ${nomes}${r.combos.length > 4 ? ' e mais' : ''}`,
        link: r.combos.length === 1 ? `./#/c/${r.combos[0].characterId}` : './#/' });
    }
    if (r.noticias.length) avisos.push({ title: 'Novidades do cenário', body: r.noticias.length === 1 ? r.noticias[0].title : `${r.noticias[0].title} e mais ${r.noticias.length - 1}`, link: LINK_NOVIDADES });
  } catch (e) { console.error('relatórios falharam:', e.message); process.exitCode = 1; }

  // notícias por RSS (feeds de fontes.json) + 1 triagem do Gemini a cada 2 h
  try {
    const c = await coletar(db);
    console.log(c.log);
    const t = await triar(db, apiKey);
    console.log(t.log);
    if (t.publicadas.length) {
      mudou = true;
      avisos.push({ title: 'Novidades do cenário', body: t.publicadas.length === 1 ? t.publicadas[0] : `${t.publicadas[0]} e mais ${t.publicadas.length - 1}`, link: LINK_NOVIDADES });
    }
  } catch (e) { console.error('notícias (rss) falharam:', e.message); process.exitCode = 1; }

  // pesquisa antiga direto no Gemini com Google Search: desligada (ligue com a variável BUSCA_GEMINI=1)
  if (apiKey && process.env.BUSCA_GEMINI === '1') {
    try {
      const n = await noticias(db, apiKey);
      console.log(n.log);
      if (n.publicadas.length) mudou = true;
    } catch (e) {
      if (/(429|503)|quota|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand/i.test(e.message)) console.warn('notícias: Gemini sem cota agora.', e.message.slice(0, 160));
      else { console.error('notícias falharam:', e.message); process.exitCode = 1; }
    }
  }

  try {
    const v = await videos(db);
    console.log(v.log);
    v.novos.sort((a, b) => b.publicado.localeCompare(a.publicado));
    if (v.novos.length > 3) avisos.push({ title: `${v.novos.length} vídeos novos de fighting games`,
      body: [...new Set(v.novos.map(x => x.canal))].slice(0, 3).join(', ') + ' e mais', link: './#/novidades?aba=videos' });
    else for (const x of v.novos) avisos.push({ title: `Vídeo novo · ${x.canal}`, body: x.titulo, link: `https://www.youtube.com/watch?v=${x.id}` });
  } catch (e) { console.error('vídeos falharam:', e.message); process.exitCode = 1; }

  // estado.json lê a base inteira (centenas de leituras): só quando algo mudou ou a cada 6 h,
  // para caber nas 50 mil leituras/dia do plano grátis do Firestore mesmo rodando a cada 5 min
  try {
    const reg = db.doc('config/estadoState'), ult = millis((await reg.get()).data()?.em);
    if (mudou || Date.now() - ult > ESTADO_MAX_MS) { console.log(await exportarEstado(db)); await reg.set({ em: FieldValue.serverTimestamp() }); }
    else console.log('estado: sem mudanças, mantido');
  } catch (e) { console.error('estado falhou:', e.message); }

  const entregues = await enviarPush(db, avisos).catch(e => { console.error('push falhou:', e.message); return 0; });
  console.log(`push: ${avisos.length} aviso(s), ${entregues} entrega(s)`);
}

if (process.argv[1]?.endsWith('robo.mjs')) {           // roda só quando chamado direto (não no teste)
  main().catch(e => { console.error(e); process.exit(1); });
}
