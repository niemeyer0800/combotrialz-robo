// ComboTrialz · robô que roda sozinho no GitHub Actions (grátis), sem ninguém online.
//
// A cada execução:
//   1. verifica as notícias "pendente" com mais de 5 min (Gemini + Google Search) e publica ou descarta;
//   2. a cada 30 min, pesquisa notícias novas e grava como "pendente";
//   3. confere os canais do YouTube cadastrados (ytCanais) e acha vídeos novos;
//   4. manda push para os aparelhos em pushTokens (notícias publicadas e vídeos novos).
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

const MODELO = process.env.GEMINI_MODELO || 'gemini-2.5-flash';
const RESERVAS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite'];
// o plano grátis do Gemini dá ~20 pedidos/dia por modelo: busca a cada 3 h + 1 verificação em lote = ~16/dia
const INTERVALO_NOTICIAS_MS = (Number(process.env.HORAS_ENTRE_BUSCAS) || 3) * 60 * 60 * 1000;
const INTERVALO_VIDEOS_MS = 10 * 60 * 1000;
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
NOTICIA|AAAA-MM-DD|Título curto|Resumo em uma ou duas frases
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
    const m = linha.match(/^\s*NOTICIA\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]+)\|(.+)$/);
    if (!m) continue;
    const [, data, tituloBruto, resumoBruto] = m;
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
    noticias.push({ dataPublicacao: data, titulo: tituloBruto.trim(), resumo: resumoBruto.trim(),
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
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${canalId}`, { headers: { 'User-Agent': 'Mozilla/5.0 (ComboTrialz)' } });
  if (!r.ok) throw new Error(`feed ${canalId}: ${r.status}`);
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
      if (motivo) descartadas++; else publicadas.push(n.titulo);
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

// ---------- execução ----------
async function main() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!sa?.private_key) throw new Error('Falta o segredo FIREBASE_SERVICE_ACCOUNT.');
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();
  const avisos = [];

  if (apiKey) {
    try {
      const n = await noticias(db, apiKey);
      console.log(n.log);
      if (n.publicadas.length) avisos.push({ title: 'ComboTrialz News',
        body: n.publicadas.length === 1 ? n.publicadas[0] : `${n.publicadas.length} novidades: ${n.publicadas[0]} e mais`, link: LINK_NOVIDADES });
    } catch (e) { console.error('notícias falharam:', e.message); process.exitCode = 1; }
  } else console.log('notícias: sem GEMINI_API_KEY, pulando');

  try {
    const v = await videos(db);
    console.log(v.log);
    v.novos.sort((a, b) => b.publicado.localeCompare(a.publicado));
    if (v.novos.length > 3) avisos.push({ title: `${v.novos.length} vídeos novos de fighting games`,
      body: [...new Set(v.novos.map(x => x.canal))].slice(0, 3).join(', ') + ' e mais', link: './#/novidades?aba=videos' });
    else for (const x of v.novos) avisos.push({ title: `Vídeo novo · ${x.canal}`, body: x.titulo, link: `https://www.youtube.com/watch?v=${x.id}` });
  } catch (e) { console.error('vídeos falharam:', e.message); process.exitCode = 1; }

  const entregues = await enviarPush(db, avisos).catch(e => { console.error('push falhou:', e.message); return 0; });
  console.log(`push: ${avisos.length} aviso(s), ${entregues} entrega(s)`);
}

if (process.argv[1]?.endsWith('robo.mjs')) {           // roda só quando chamado direto (não no teste)
  main().catch(e => { console.error(e); process.exit(1); });
}
