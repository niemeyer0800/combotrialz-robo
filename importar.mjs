// Importa o relatório diário do Claude (combotrialz/report@1) no Firestore.
// É a mesma lógica do botão "Configurações → Importar relatório" do app,
// copiada do código do app para dar exatamente o mesmo resultado.

const SCHEMA = 'combotrialz/report@1';
const SCHEMAS_ANTIGOS = ['sf6-combo-lab/report@1'];
const CATEGORIAS = ['confirm_leve', 'confirm_medio', 'punicao_pesada', 'punish_counter', 'counter_hit', 'whiff_punish', 'anti_aereo', 'jump_in', 'drive_impact', 'drive_rush', 'burnout', 'perfect_parry', 'pos_arremesso', 'finalizacao'];
const POSICOES = ['qualquer', 'meio', 'canto'];
const SITUACOES = ['max_dano', 'sem_recursos', 'economiza_drive', 'leva_ao_canto', 'troca_de_lado', 'oki_forte', 'constroi_super', 'oponente_burnout', 'fim_de_round'];
const SUPERS = ['SA1', 'SA2', 'SA3', 'CA'];
export const TIPOS_NOTICIA = ['cenario', 'torneio', 'patch', 'personagem', 'combo', 'comunidade'];
const BARRAS_SUPER = { SA1: 1, SA2: 2, SA3: 3, CA: 3 };

// ---------- ids (iguais aos do app) ----------
function fnv(e) { let t = 2166136261; for (let n = 0; n < e.length; n++) t ^= e.charCodeAt(n), t = Math.imul(t, 16777619) >>> 0; return t.toString(16).padStart(8, '0'); }
function normalizaNotacao(e) { return e.toUpperCase().replace(/\bXX\b/g, '>').replace(/\bDP\s*~\s*R\b/g, 'PDR').replace(/\bDPR\b/g, 'PDR').replace(/\s+/g, '').replace(/,+/g, ','); }
export function fingerprint(personagem, controle, notacao) { return `${personagem}-${controle[0]}-${fnv(`${personagem}|${controle}|${normalizaNotacao(notacao)}`)}`; }
export const idNoticiaUrl = url => `n-${fingerprint('news', 'x', url).split('-').pop()}`;
export const dominio = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'web'; } };

// ---------- validação do relatório (pn no app) ----------
function fontes(e) {
  return Array.isArray(e) ? e.filter(x => x && typeof x.url === 'string' && /^https?:\/\//.test(x.url)).map(x => ({
    url: String(x.url), title: String(x.title ?? x.url).slice(0, 200),
    publishedAt: typeof x.publishedAt === 'string' ? x.publishedAt.slice(0, 10) : null,
    ...(typeof x.accessedAt === 'string' ? { accessedAt: x.accessedAt.slice(0, 10) } : {}),
  })) : [];
}
export function validarRelatorio(n) {
  const erros = [];
  if (!n || typeof n !== 'object') return { report: null, errors: ['O arquivo não é um objeto JSON.'] };
  if (n.schema !== SCHEMA && !SCHEMAS_ANTIGOS.includes(n.schema)) erros.push(`Campo "schema" ausente ou diferente de "${SCHEMA}".`);
  if (!Array.isArray(n.proposals)) return { report: null, errors: [...erros, 'Campo "proposals" precisa ser uma lista.'] };
  const props = [];
  n.proposals.forEach((e, i) => {
    const nome = `Proposta ${i + 1}`, tipo = e?.type;
    if (!['new_combo', 'broken_combo', 'damage_update', 'patch', 'note'].includes(tipo)) { erros.push(`${nome}: tipo "${tipo}" inválido.`); return; }
    const src = fontes(e.sources), alvo = tipo === 'broken_combo' && typeof e.targetComboId === 'string';
    if (tipo !== 'note' && !alvo && src.length === 0) { erros.push(`${nome}: sem fonte com link — descartada.`); return; }
    const c = { type: tipo, notes: String(e.notes ?? '').slice(0, 1000), sources: src,
      confidence: ['alta', 'media', 'baixa'].includes(e.confidence) ? e.confidence : 'baixa',
      targetComboId: typeof e.targetComboId === 'string' ? e.targetComboId : null };
    if (tipo === 'patch') c.patch = { version: e.patch?.version ?? null, date: e.patch?.date ?? null, url: e.patch?.url ?? src[0]?.url ?? null,
      summary: e.patch?.summary ?? null, affectedCharacters: Array.isArray(e.patch?.affectedCharacters) ? e.patch.affectedCharacters.map(String) : [] };
    if (tipo === 'new_combo' || tipo === 'damage_update' || tipo === 'broken_combo') {
      const k = e.combo ?? {};
      if (!k.characterId || !k.notation) { erros.push(`${nome}: combo sem personagem ou notação.`); return; }
      const ctrl = k.controls === 'modern' ? 'modern' : 'classic';
      const dano = typeof k.damage === 'number' && k.damage > 0 && k.damage <= 12000 ? Math.round(k.damage) : null;
      c.combo = { characterId: String(k.characterId), controls: ctrl, notation: String(k.notation).slice(0, 300),
        title: k.title ? String(k.title).slice(0, 120) : null, category: CATEGORIAS.includes(k.category) ? k.category : 'confirm_medio',
        position: POSICOES.includes(k.position) ? k.position : 'qualquer', situations: Array.isArray(k.situations) ? k.situations.filter(x => SITUACOES.includes(x)) : [],
        optimalWhen: k.optimalWhen ? String(k.optimalWhen).slice(0, 400) : '', damage: dano,
        drive: typeof k.drive === 'number' ? k.drive : null, superBars: typeof k.superBars === 'number' ? k.superBars : null,
        supers: Array.isArray(k.supers) ? k.supers.filter(x => SUPERS.includes(x)) : [], ca: !!k.ca,
        extra: k.extra ? String(k.extra).slice(0, 120) : null, difficulty: [1, 2, 3, 4, 5].includes(k.difficulty) ? k.difficulty : null,
        endsWith: k.endsWith ? String(k.endsWith).slice(0, 160) : null };
      c.fingerprint = fingerprint(c.combo.characterId, ctrl, c.combo.notation);
      if (tipo === 'new_combo' && dano == null) c.notes = `${c.notes} (fonte não informa dano)`.trim();
    }
    props.push(c);
  });
  return { report: {
    schema: SCHEMA, checkedAt: typeof n.checkedAt === 'string' ? n.checkedAt : new Date().toISOString(),
    backfillCharacters: Array.isArray(n.backfillCharacters) ? n.backfillCharacters.map(String) : [],
    patch: { changed: !!n.patch?.changed, version: n.patch?.version ?? null, date: n.patch?.date ?? null, url: n.patch?.url ?? null,
      summary: n.patch?.summary ?? null, affectedCharacters: Array.isArray(n.patch?.affectedCharacters) ? n.patch.affectedCharacters.map(String) : [] },
    proposals: props,
    news: Array.isArray(n.news) ? n.news.filter(e => e && typeof e.url === 'string' && /^https?:\/\//.test(e.url) && typeof e.title === 'string').slice(0, 30).map(e => ({
      title: String(e.title).slice(0, 200), url: String(e.url), date: typeof e.date === 'string' ? e.date.slice(0, 10) : null,
      summary: String(e.summary ?? '').slice(0, 600), source: e.source ? String(e.source).slice(0, 60) : dominio(String(e.url)),
      kind: TIPOS_NOTICIA.includes(e.kind) ? e.kind : 'cenario', characterIds: Array.isArray(e.characterIds) ? e.characterIds.map(String).slice(0, 10) : [] })) : [],
    sourcesChecked: Array.isArray(n.sourcesChecked) ? n.sourcesChecked.map(String).slice(0, 50) : [],
    noNewsReason: n.noNewsReason ?? null,
  }, errors: erros };
}

// ---------- recursos pela notação (Qt no app) ----------
function limpaNotacao(e) { return e.replace(/\bxx\b/gi, '>').replace(/\bDP\s*~\s*R\b/gi, 'PDR').replace(/\bDPR\b/gi, 'PDR').replace(/\bDR\s*~\s*/gi, 'DR ').replace(/\(BM\)/gi, ' ').replace(/\s+/g, ' ').trim(); }
function recursos(e) {
  const t = [], avisos = [], supers = [];
  let drive = 0, barras = 0, ca = false, superPorMovimento = false, sep = null;
  for (const parte of limpaNotacao(e).split(/\s*(>|,)\s*/).filter(x => x !== '')) {
    if (parte === '>' || parte === ',') { sep = parte; continue; }
    parte.split(' ').filter(Boolean).forEach((x, i) => {
      const u = i === 0 ? sep : ',', d = x.replace(/^\(|\)$/g, '');
      let f = 0, p = 0, m = '';
      if (/^PDR$/i.test(d)) { f = 1; m = 'Drive Rush do Parry'; }
      else if (/^DRC$/i.test(d)) { f = 3; m = 'Drive Rush cancel'; }
      else if (/^DR$/i.test(d)) { if (u === '>') { f = 3; m = 'Drive Rush cancel'; } else { f = 1; m = 'Drive Rush cru'; } }
      else if (/^DI$/i.test(d)) { f = 1; m = 'Drive Impact'; }
      else if (/^DRev$|^DRV$/i.test(d)) { f = 2; m = 'Drive Reversal'; }
      else if (/^OD$/i.test(d)) { f = 2; m = 'Overdrive'; }
      else if (/^OD[.\-]?\S+/i.test(d) || /\d\]?\d*(PP|KK)/.test(d)) { f = 2; m = 'Overdrive'; if (/^\d?2PP~P/.test(d)) avisos.push(`"${d}" pode não ser OD (ex.: Blanka 2PP). Confira.`); }
      const h = d.match(/^SA([123])$/i);
      if (h) { const s = `SA${h[1]}`; supers.push(s); p = BARRAS_SUPER[s]; m ||= `Super Art nível ${h[1]}`; }
      else if (/^CA$/i.test(d)) { supers.push('CA'); p = 3; ca = true; m ||= 'Critical Art'; }
      else if (/(236236|214214|41236|63214\d*|2141236)[PK]/i.test(d)) { superPorMovimento = true; m ||= 'Super (nível pela movimentação)'; }
      if (f || p) { drive += f; barras += p; t.push({ atom: d, drive: f, superBars: p, label: m }); }
    });
    sep = null;
  }
  if (superPorMovimento) avisos.push('Super escrito como movimento (ex.: 236236P): o nível depende do personagem. Use SA1/SA2/SA3/CA na notação.');
  if (drive > 6) avisos.push(`Soma ${drive} barras de Drive: só funciona se o combo recupera Drive no caminho.`);
  if (barras > 3) avisos.push(`Soma ${barras} barras de Super: confira se o combo gera Super no caminho.`);
  return { drive, superBars: barras, supers, ca, extra: null, origin: 'calculado', warnings: avisos, breakdown: t };
}

// ---------- aplicar propostas (vn/hn/mn no app) ----------
const rotuloPatch = meta => ({ label: `v${meta.balancePatch.version.split(' ')[0]} (${meta.balancePatch.date.split('-').reverse().join('/')})`, date: meta.balancePatch.date });
function novoCombo(e, patch, agora) {
  const r = e.combo, calc = recursos(r.notation), daFonte = r.drive != null || r.superBars != null, avisos = [...(calc.warnings ?? [])];
  if (daFonte && r.drive != null && r.drive !== calc.drive) avisos.push(`A fonte diz ${r.drive} barras de Drive; a notação soma ${calc.drive}.`);
  const id = fingerprint(r.characterId, r.controls, r.notation);
  return { id, characterId: r.characterId, controls: r.controls, notation: r.notation, notationSource: null, title: r.title ?? null,
    category: r.category, position: r.position, situations: r.situations, optimalWhen: r.optimalWhen || '', damage: r.damage,
    damageOrigin: r.damage == null ? null : 'fonte',
    resources: { drive: r.drive ?? calc.drive, superBars: r.superBars ?? calc.superBars, supers: r.supers && r.supers.length ? r.supers : calc.supers,
      ca: r.ca || calc.ca, extra: r.extra ?? null, origin: daFonte ? 'fonte' : 'calculado', warnings: avisos },
    endsWith: r.endsWith ?? null, difficulty: r.difficulty ?? null, status: 'fonte', patch, sources: e.sources, notes: e.notes || null,
    fingerprint: id, verificationCount: 0, createdAt: agora, updatedAt: agora };
}
function aplicarUma(e, combos, meta, agora) {
  const patch = rotuloPatch(meta), porFp = new Map(combos.map(c => [c.fingerprint, c]));
  const alvo = e.targetComboId ? combos.find(c => c.id === e.targetComboId) : e.fingerprint ? porFp.get(e.fingerprint) : undefined;
  switch (e.type) {
    case 'new_combo': return alvo ? { updates: [] } : { upsert: novoCombo(e, patch, agora), updates: [] };
    case 'damage_update': return alvo ? { updates: [{ id: alvo.id, changes: { damage: e.combo?.damage ?? alvo.damage, damageOrigin: 'fonte',
      status: alvo.status === 'verificado' ? 'verificado' : 'fonte', sources: [...e.sources, ...alvo.sources], patch, updatedAt: agora } }] }
      : { upsert: novoCombo(e, patch, agora), updates: [] };
    case 'broken_combo': return alvo ? { updates: [{ id: alvo.id, changes: { status: 'quebrado',
      notes: [alvo.notes, `Não funciona desde ${patch.label}: ${e.notes}`].filter(Boolean).join(' '), sources: [...e.sources, ...alvo.sources], updatedAt: agora } }] }
      : { updates: [] };
    case 'patch': {
      const af = new Set(e.patch?.affectedCharacters ?? []), todos = af.size === 0;
      const updates = combos.filter(c => (todos || af.has(c.characterId)) && (c.status === 'verificado' || c.status === 'fonte'))
        .map(c => ({ id: c.id, changes: { status: 'revisar', updatedAt: agora } }));
      return { updates, meta: e.patch?.date ? { balancePatch: { label: e.patch.summary?.slice(0, 120) || 'Novo patch', version: e.patch.version ?? 'a confirmar',
        date: e.patch.date, source: e.sources[0] }, updatedAt: agora } : undefined };
    }
    default: return { updates: [] };
  }
}
export function aplicarPropostas(props, combos, meta, agora, apagados = new Set()) {
  const ordem = [...props].sort((a, b) => Number(b.type === 'patch') - Number(a.type === 'patch'));
  const mapa = new Map(combos.map(c => [c.id, c])), novos = new Set(), mudados = new Set();
  let m = meta, metaNova = null, pulados = 0;
  for (const e of ordem) {
    const fp = e.type === 'new_combo' || e.type === 'damage_update' ? (e.fingerprint || (e.combo ? fingerprint(e.combo.characterId, e.combo.controls, e.combo.notation) : null)) : null;
    if (fp && apagados.has(fp)) { pulados++; continue; }
    const r = aplicarUma(e, [...mapa.values()], m, agora);
    if (r.upsert) { mapa.set(r.upsert.id, r.upsert); novos.add(r.upsert.id); }
    for (const u of r.updates) { const c = mapa.get(u.id); if (c) { mapa.set(u.id, { ...c, ...u.changes }); if (!novos.has(u.id)) mudados.add(u.id); } }
    if (r.meta) {
      const hist = [...(m.patchHistory ?? [])];
      if (e.patch?.date && e.sources[0]) hist.unshift({ date: e.patch.date, label: e.patch.summary ?? 'Patch', source: e.sources[0] });
      metaNova = { ...(metaNova ?? {}), ...r.meta, patchHistory: hist }; m = { ...m, ...r.meta, patchHistory: hist };
    }
    if (!r.upsert && r.updates.length === 0 && !r.meta) pulados++;
  }
  return { changed: [...novos, ...mudados].map(id => mapa.get(id)), added: novos.size, updated: mudados.size, skipped: pulados, meta: metaNova };
}

// notícias do relatório no formato da coleção "news" (un no app)
export const noticiasDoRelatorio = (rel, runId) => rel.news.map(n => ({
  id: idNoticiaUrl(n.url), title: n.title, url: n.url, source: n.source ?? dominio(n.url), publishedAt: n.date, summary: n.summary,
  kind: n.kind ?? 'cenario', characterIds: n.characterIds ?? [], createdAt: rel.checkedAt, runId }));

const limpo = o => JSON.parse(JSON.stringify(o));

// importReport do app, com o Admin SDK. Devolve o que entrou de novo (para o push).
export async function importarRelatorio(db, bruto) {
  const { report: rel, errors } = validarRelatorio(bruto);
  if (!rel) throw new Error(errors.join(' '));
  const metaSnap = await db.doc('meta/game').get();
  if (!metaSnap.exists) throw new Error('A base ainda não foi carregada (meta/game não existe).');
  const meta = metaSnap.data();
  const combos = (await db.collection('combos').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const apagados = new Set((await db.collection('deletedCombos').get()).docs.map(d => d.id));
  const hoje = new Date().toISOString().slice(0, 10);
  const r = aplicarPropostas(rel.proposals.filter(p => p.type !== 'note' && p.sources.length > 0), combos, meta, hoje, apagados);
  const runId = `${rel.checkedAt.slice(0, 10)}-importado`;
  const ops = r.changed.map(c => b => b.set(db.doc(`combos/${c.id}`), limpo(c)));
  if (r.meta) ops.push(b => b.set(db.doc('meta/game'), limpo(r.meta), { merge: true }));
  const noticias = noticiasDoRelatorio(rel, runId), novasNoticias = [];
  for (const n of noticias) {
    const atual = await db.doc(`news/${n.id}`).get();
    if (atual.exists && atual.get('removed')) continue;               // derrubada pela comunidade: não volta
    if (!atual.exists) novasNoticias.push(n);
    ops.push(b => b.set(db.doc(`news/${n.id}`), limpo(n), { merge: true }));
  }
  ops.push(b => b.set(db.doc(`runs/${runId}`), limpo({ id: runId, checkedAt: rel.checkedAt, origin: 'tarefa-agendada',
    proposalsCreated: r.added, duplicatesSkipped: r.skipped, patchChanged: rel.patch.changed,
    summary: r.added || r.updated ? `${r.added} combo(s) novo(s) na lista${r.updated ? `, ${r.updated} atualizado(s)` : ''}.` : rel.noNewsReason || 'Nada novo.',
    backfillCharacters: rel.backfillCharacters })));
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
  const novosCombos = r.changed.filter(c => c.createdAt === hoje && !combos.some(x => x.id === c.id));
  return { added: r.added, updated: r.updated, skipped: r.skipped, erros: errors, novosCombos, novasNoticias, patch: r.meta?.balancePatch || null };
}
