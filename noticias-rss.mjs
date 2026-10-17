// Notícias por RSS: lê os feeds de fontes.json, filtra o que é de jogo de luta (principalmente
// Street Fighter), junta repetidas e, a cada 2 h, usa UMA chamada do Gemini para traduzir,
// resumir e classificar o lote. O que for relevante entra na coleção "news" (aba Cenário).
// Só guarda título, resumo curto e link: a matéria continua sendo lida no site original.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FieldValue } from 'firebase-admin/firestore';
import { idNoticiaUrl, TIPOS_NOTICIA } from './importar.mjs';

const COLETA_MS = 15 * 60 * 1000;          // lê os feeds a cada 15 min
const TRIAGEM_MS = 2 * 60 * 60 * 1000;     // traduz/classifica a cada 2 h (1 chamada do Gemini)
const SEM_GEMINI_MS = 8 * 60 * 60 * 1000;  // sem cota por 8 h: publica as mais fortes sem traduzir
const IDADE_MAX_MS = 2 * 24 * 60 * 60 * 1000;
const NOTA_MINIMA = 4;
const MODELOS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite'];

// ---------- personagens (para marcar characterIds) ----------
export const PERSONAGENS = {
  aki: ['a\.k\.i\.?', 'aki'], akuma: ['akuma', 'gouki'], alex: ['alex'], arjun: ['arjun'], blanka: ['blanka'], cammy: ['cammy'],
  chunli: ['chun[- ]?li'], cviper: ['c\. ?viper', 'crimson viper'], deejay: ['dee ?jay'], dhalsim: ['dhalsim'],
  ed: ['ed'], ehonda: ['e\. ?honda'], elena: ['elena'], guile: ['guile'], ingrid: ['ingrid'], jamie: ['jamie'],
  jp: ['jp'], juri: ['juri'], ken: ['ken'], kimberly: ['kimberly'], lily: ['lily'], luke: ['luke'], mai: ['mai shiranui', 'mai'],
  manon: ['manon'], marisa: ['marisa'], mbison: ['m\. ?bison', 'bison'], rashid: ['rashid'], ryu: ['ryu'], sagat: ['sagat'],
  terry: ['terry bogard', 'terry'], yasmine: ['yasmine'], zangief: ['zangief'],
};
// nomes que parecem personagem mas não são (Ed Boon é o criador de Mortal Kombat; Honda carro etc.)
const NAO_E = { ed: /\bed boon\b/i, ken: /\bken (masters )?(levine|kutaragi)\b/i, luke: /\bluke (skywalker|cage)\b/i };
const RE_PERS = Object.fromEntries(Object.entries(PERSONAGENS).map(([id, nomes]) => [id, new RegExp(`(^|[^\\w])(${nomes.join('|')})(?![\\w])`, 'i')]));

// ---------- filtro por pontuação ----------
const FORTES = [/street\s*fighter/i, /\bsf6\b/i, /\bsfvi\b/i, /capcom pro tour/i, /\bcpt\s*20\d\d/i, /capcom cup/i, /street fighter league/i, /\bfgc\b/i, /fighting game/i, /jogos? de luta/i];
const LUTA = [/\btekken\b/i, /fatal fury/i, /city of the wolves/i, /\b2xko\b/i, /guilty gear/i, /granblue fantasy versus/i, /mortal kombat/i, /virtua fighter/i, /marvel tokon/i, /under night/i, /blazblue/i, /king of fighters|\bkof\b/i, /\bevo\b(?! ?\d{3})/i, /\bewc\b|esports world cup/i];
const RUIDO = [/\bdeals?\b/i, /\bsale\b/i, /desconto/i, /promo(ç|c)(ã|a)o/i, /\boferta/i, /price drop/i, /\bcoupon/i, /gift guide/i, /\bstocks?\b/i];
export function nota(texto) {
  const t = ` ${texto} `;
  let n = 0;
  for (const r of FORTES) if (r.test(t)) n += 5;
  for (const r of LUTA) if (r.test(t)) n += 3;
  n += Math.min(3, personagensDe(texto).length);
  for (const r of RUIDO) if (r.test(t)) n -= 6;
  return n;
}
export function personagensDe(texto) {
  return Object.entries(RE_PERS).filter(([id, re]) => {
    if (!re.test(texto)) return false;
    // "Ed Boon" sozinho não conta; conta se o nome aparecer de novo fora da exceção
    if (NAO_E[id]) return re.test(texto.replace(new RegExp(NAO_E[id].source, 'gi'), ''));
    return true;
  }).map(([id]) => id).slice(0, 6);
}

// ---------- leitura de RSS/Atom (sem dependências) ----------
const ent = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(amp|lt|gt|quot|apos|#39|#8217|#8216|#8220|#8221|#8211|#8212|nbsp);/g,
  (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', nbsp: ' ' }[e]))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const limpar = s => ent(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (bloco, nome) => { const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'i')); return m ? m[1] : ''; };
export function lerFeed(xml, fonteNome) {
  const itens = [];
  for (const [, b] of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const src = b.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
    itens.push({ titulo: limpar(tag(b, 'title')), link: limpar(tag(b, 'link')), data: Date.parse(limpar(tag(b, 'pubDate'))) || Date.now(),
      resumo: limpar(tag(b, 'description')).slice(0, 400), fonte: src ? limpar(src[2]) : fonteNome, fonteUrl: src ? src[1] : null });
  }
  for (const [, b] of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
    const href = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    itens.push({ titulo: limpar(tag(b, 'title')), link: ent(href), data: Date.parse(limpar(tag(b, 'published') || tag(b, 'updated'))) || Date.now(),
      resumo: limpar(tag(b, 'summary') || tag(b, 'content')).slice(0, 400), fonte: fonteNome, fonteUrl: null });
  }
  // o Google Notícias põe " - Nome do site" no fim do título
  return itens.filter(i => i.titulo && /^https?:\/\//.test(i.link)).map(i => ({ ...i, titulo: i.fonteUrl ? i.titulo.replace(/\s+-\s+[^-]+$/, '') : i.titulo }));
}
const googleUrl = (busca, idioma) => idioma === 'pt'
  ? `https://news.google.com/rss/search?q=${encodeURIComponent(busca)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`
  : `https://news.google.com/rss/search?q=${encodeURIComponent(busca)}&hl=en-US&gl=US&ceid=US:en`;
async function baixar(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ComboTrialz news reader)' }, signal: AbortSignal.timeout(12000) }).catch(() => null);
    if (r && r.ok) return r.text();
    await new Promise(ok => setTimeout(ok, 1200 * (i + 1)));
  }
  return null;
}

// ---------- repetidas ----------
const palavras = t => new Set(t.toLowerCase().normalize('NFD').replace(/[^\w ]+/g, ' ').split(/\s+/).filter(w => w.length > 2));
export function parecidas(a, b) {
  const A = palavras(a), B = palavras(b);
  if (!A.size || !B.size) return false;
  let comum = 0; for (const w of A) if (B.has(w)) comum++;
  return comum / Math.min(A.size, B.size) >= 0.7;
}
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---------- 1) coleta ----------
export async function coletar(db, forcar = false) {
  const estRef = db.doc('config/rssState'), est = (await estRef.get()).data() || {};
  const ms = v => v?.toMillis ? v.toMillis() : 0;
  if (!forcar && Date.now() - ms(est.ultimaColeta) < COLETA_MS) return { log: 'rss: coletado há pouco', novos: 0 };
  const fontes = JSON.parse(await readFile(new URL('./fontes.json', import.meta.url), 'utf8'));
  const lista = [...(fontes.rss || []).map(f => ({ nome: f.nome, url: f.url })),
    ...(fontes.google || []).map(g => ({ nome: 'Google Notícias', url: googleUrl(g.busca, g.idioma) }))];
  const brutos = [];
  let falhas = 0;
  await Promise.all(lista.map(async f => { const x = await baixar(f.url); if (x) brutos.push(...lerFeed(x, f.nome)); else falhas++; }));

  const filaRef = db.doc('config/rssFila'), fila = (await filaRef.get()).data() || {};
  const vistos = fila.vistos || {}, itens = fila.itens || [];
  const agora = Date.now();
  let novos = 0;
  for (const i of brutos.sort((a, b) => b.data - a.data)) {
    if (agora - i.data > IDADE_MAX_MS) continue;
    const h = hash(i.link), n = nota(`${i.titulo} ${i.resumo}`);
    if (vistos[h] || n < NOTA_MINIMA) { vistos[h] ||= agora; continue; }
    vistos[h] = agora;
    if (itens.some(x => parecidas(x.titulo, i.titulo))) continue;          // mesma notícia em outro site
    itens.push({ id: h, titulo: i.titulo, link: i.link, fonte: i.fonte, resumo: i.resumo, data: i.data, nota: n,
      personagens: personagensDe(`${i.titulo} ${i.resumo}`), entrouEm: agora });
    novos++;
  }
  // guarda só os últimos 3 dias de "vistos" e no máximo 80 na fila
  for (const k of Object.keys(vistos)) if (agora - vistos[k] > 3 * IDADE_MAX_MS / 2) delete vistos[k];
  const fila80 = itens.sort((a, b) => b.nota - a.nota || b.data - a.data).slice(0, 80);
  await filaRef.set({ itens: fila80, vistos });
  await estRef.set({ ultimaColeta: FieldValue.serverTimestamp(), ultimaColetaQtd: brutos.length }, { merge: true });
  return { log: `rss: ${brutos.length} itens lidos de ${lista.length - falhas}/${lista.length} fontes, ${novos} novo(s) na fila (${fila80.length} esperando)`, novos };
}

// ---------- 2) triagem com o Gemini (1 chamada para o lote) ----------
function promptTriagem(lote) {
  return `Você é o editor de notícias do ComboTrialz, um app brasileiro de Street Fighter 6.
Abaixo há manchetes coletadas de sites de notícias. Para cada uma, decida se é NOTÍCIA real e relevante
para quem joga jogos de luta (prioridade: Street Fighter; também Tekken, Fatal Fury, 2XKO, Guilty Gear,
Mortal Kombat, torneios como EVO/CPT/Capcom Cup). Atenção: Ed Boon é o criador de Mortal Kombat, não o personagem Ed. Não são relevantes: ofertas e promoções, guias genéricos,
listas de "melhores jogos", matérias que só citam o jogo de passagem, rumores sem fonte.

Para as relevantes, escreva em português do Brasil:
- "titulo": a manchete traduzida, curta e fiel (sem exagero);
- "resumo": 1 ou 2 frases só com o que a manchete e o trecho dizem. NÃO invente nada além disso;
- "kind": um de torneio, patch, personagem, combo, cenario, comunidade;
- "personagens": ids de personagens de SF6 citados (aki, akuma, alex, arjun, blanka, cammy, chunli, cviper, deejay,
  dhalsim, ed, ehonda, elena, guile, ingrid, jamie, jp, juri, ken, kimberly, lily, luke, mai, manon, marisa, mbison,
  rashid, ryu, sagat, terry, yasmine, zangief).
Se duas manchetes forem a mesma notícia, marque só uma como relevante.

Responda SOMENTE com JSON, uma lista com um item por manchete:
[{"n": 1, "relevante": true, "titulo": "...", "resumo": "...", "kind": "torneio", "personagens": []},
 {"n": 2, "relevante": false}]

MANCHETES:
${lote.map((i, k) => `${k + 1}) [${i.fonte}] ${i.titulo}${i.resumo ? `\n   Trecho: ${i.resumo.slice(0, 280)}` : ''}`).join('\n')}`;
}
async function geminiJson(apiKey, prompt) {
  let erro;
  for (const m of MODELOS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const m2 = txt.match(/\[[\s\S]*\]/);
      return JSON.parse(m2 ? m2[0] : txt);
    }
    erro = new Error(`Gemini (${m}) ${r.status}: ${j.error?.message || 'erro'}`);
    if (![404, 429, 500, 503, 0].includes(r.status)) throw erro;
  }
  throw erro;
}
const isoSP = (ms = Date.now()) => `${new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19)}-03:00`;
const dataSP = ms => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function publicar(db, i, t) {
  const ref = db.doc(`news/${idNoticiaUrl(i.link)}`), atual = await ref.get();
  if (atual.exists) return false;
  await ref.set({ id: ref.id, title: (t.titulo || i.titulo).slice(0, 200), url: i.link, source: i.fonte, publishedAt: dataSP(i.data),
    summary: (t.resumo || i.resumo || '').slice(0, 600), kind: TIPOS_NOTICIA.includes(t.kind) ? t.kind : 'cenario',
    characterIds: (Array.isArray(t.personagens) ? t.personagens : []).filter(x => PERSONAGENS[x] && i.personagens.includes(x)).slice(0, 10),
    createdAt: isoSP(), runId: `${dataSP(Date.now())}-rss` });
  return true;
}

export async function triar(db, apiKey, forcar = false) {
  const estRef = db.doc('config/rssState'), est = (await estRef.get()).data() || {};
  const ms = v => v?.toMillis ? v.toMillis() : 0;
  const filaRef = db.doc('config/rssFila'), fila = (await filaRef.get()).data() || {};
  const itens = fila.itens || [];
  if (!itens.length) return { log: 'rss: fila vazia', publicadas: [] };
  if (!forcar && Date.now() - ms(est.ultimaTriagem) < TRIAGEM_MS) return { log: `rss: ${itens.length} na fila, próxima triagem em breve`, publicadas: [] };
  const lote = itens.slice(0, 40), publicadas = [];
  let resultado = null, motivo = '';
  if (apiKey) {
    try { resultado = await geminiJson(apiKey, promptTriagem(lote)); }
    catch (e) { motivo = e.message.slice(0, 140); }
  }
  if (resultado) {
    const porN = new Map(resultado.filter(x => Number.isInteger(x.n)).map(x => [x.n, x]));
    for (const [k, i] of lote.entries()) {
      const t = porN.get(k + 1);
      if (t?.relevante && await publicar(db, i, t)) publicadas.push(t.titulo || i.titulo);
    }
    await filaRef.set({ itens: itens.slice(lote.length) }, { merge: true });
    await estRef.set({ ultimaTriagem: FieldValue.serverTimestamp(), semGeminiDesde: null }, { merge: true });
    return { log: `rss: triagem de ${lote.length}, ${publicadas.length} publicada(s)`, publicadas };
  }
  // sem Gemini (sem chave ou sem cota): depois de 8 h, publica só as de Street Fighter mais fortes, sem traduzir
  const desde = ms(est.semGeminiDesde) || Date.now();
  await estRef.set({ semGeminiDesde: est.semGeminiDesde || FieldValue.serverTimestamp() }, { merge: true });
  if (Date.now() - desde < SEM_GEMINI_MS) return { log: `rss: Gemini indisponível (${motivo || 'sem chave'}), fila aguardando`, publicadas: [] };
  const fortes = lote.filter(i => i.nota >= 10);
  for (const i of fortes) if (await publicar(db, i, {})) publicadas.push(i.titulo);
  await filaRef.set({ itens: itens.filter(i => !fortes.includes(i)).slice(0, 80) }, { merge: true });
  return { log: `rss: sem Gemini há mais de 8 h, ${publicadas.length} publicada(s) sem tradução`, publicadas };
}
