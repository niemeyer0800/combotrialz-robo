// Testes rápidos sem Firebase: node teste.mjs
// Com GEMINI_API_KEY definido, também faz uma busca real no Gemini.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importarRelatorio, idNoticiaUrl } from './importar.mjs';
import { idNoticia, parseNoticias, parseVeredito, parseVereditos, dataEhRecente, somarDias, feedYoutube, gemini, extrairResposta } from './robo.mjs';

// mesmo ID que o app gera no navegador (conferido no app)
assert.equal(idNoticia({ dataPublicacao: '2026-10-14', titulo: 'Arjun chega a Street Fighter 6 e vendas superam 7 milhões' }), '9f9a9382bcb72b845fe4');

assert.equal(somarDias('2026-03-01', -1), '2026-02-28');
assert.ok(dataEhRecente('2026-10-15', '2026-10-16'));
assert.ok(!dataEhRecente('2026-10-10', '2026-10-16'));
assert.deepEqual(parseVeredito('ok {"real": true, "data_publicacao": "2026-10-16", "motivo": "x"}'), { real: true, dataPublicacao: '2026-10-16', motivo: 'x' });

// citações em bytes: "ã" ocupa 2 bytes
const texto = 'NOTICIA|2026-10-16|Título|Ação confirmada hoje.\nNOTICIA|2026-10-16|Sem fonte|Nada.';
const fim = Buffer.byteLength('NOTICIA|2026-10-16|Título|Ação confirmada hoje.');
const r = extrairResposta({ candidates: [{ content: { parts: [{ text: texto }] }, groundingMetadata: {
  webSearchQueries: ['q'], groundingChunks: [{ web: { uri: 'https://ex.com/a', title: 'ex.com' } }],
  groundingSupports: [{ segment: { endIndex: fim }, groundingChunkIndices: [0] }] } }] });
const ns = parseNoticias(r.texto, r.citacoes);
assert.equal(ns.length, 1, 'notícia sem fonte é descartada');
assert.equal(ns[0].resumoComFontes, 'Ação confirmada hoje. [ex.com](https://ex.com/a)');
const vv = parseVereditos('x [{"n":1,"real":true,"data_publicacao":"2026-10-16","motivo":"ok"},{"n":2,"real":false,"data_publicacao":null,"motivo":"boato"}] y');
assert.equal(vv.get(1).real, true); assert.equal(vv.get(2).motivo, 'boato');
console.log('funções: ok');

// import do relatório real num Firestore de mentira
{
  const real = JSON.parse(readFileSync('teste-dados/relatorio-2026-10-16.json', 'utf8'));
  const store = new Map([['meta/game', { balancePatch: { version: '2.0', date: '2026-10-13' } }],
    ['news/' + idNoticiaUrl(real.news[1].url), { url: real.news[1].url, removed: { reason: 'comunidade' } }]]);
  const snap = k => ({ exists: store.has(k), id: k.split('/').pop(), data: () => store.get(k), get: f => store.get(k)?.[f] });
  const set = (k, v, o) => store.set(k, o?.merge ? { ...(store.get(k) || {}), ...v } : v);
  const db = { doc: k => ({ path: k, get: async () => snap(k), set: async (v, o) => set(k, v, o) }),
    collection: c => ({ get: async () => ({ docs: [...store.keys()].filter(k => k.startsWith(c + '/')).map(snap) }) }),
    batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => set(r.path, v, o)), commit: async () => ops.forEach(f => f()) }; } };
  const r = await importarRelatorio(db, real);
  assert.equal(r.novasNoticias.length, 3, 'a notícia derrubada pela comunidade não volta');
  assert.ok(store.has('runs/2026-10-16-importado'));
  // combo com fonte antiga entra como "a verificar"; com fonte pós-patch, como "fonte"
  const r2 = await importarRelatorio(db, { schema: 'combotrialz/report@1', checkedAt: '2026-10-16T12:00:00-03:00', proposals: [
    { type: 'new_combo', combo: { characterId: 'ryu', controls: 'modern', notation: '2L, 5L > SP+M' }, sources: [{ url: 'https://ex.com/velho', publishedAt: '2025-06-01' }] },
    { type: 'new_combo', combo: { characterId: 'ryu', controls: 'modern', notation: '5H > SP+H' }, sources: [{ url: 'https://ex.com/novo', publishedAt: '2026-10-14' }] } ], news: [] });
  const st = r2.novosCombos.map(c => c.status).sort();
  assert.deepEqual(st, ['a_verificar', 'fonte']);
  console.log('import do relatório: ok');
}

// o feed do YouTube às vezes fica fora do ar para um canal; isso não é erro do robô
try {
  const vs = await feedYoutube('UCVg9nCmmfIyP4QcGOnZZ9Qg');
  assert.ok(vs.length > 0 && vs[0].id && vs[0].publicado);
  console.log(`youtube: ok (${vs.length} vídeos; último: ${vs[0].titulo})`);
} catch (e) { console.warn('youtube: feed instável agora (' + e.message + ')'); }

if (process.env.GEMINI_API_KEY) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const g = await gemini(process.env.GEMINI_API_KEY, `Hoje é ${hoje}. Pesquise no Google a notícia mais recente de Street Fighter 6 e responda numa linha:\nNOTICIA|AAAA-MM-DD|Título|Resumo`);
  console.log(`gemini: pesquisou=${g.pesquisou}, citações=${g.citacoes.length}, notícias=${parseNoticias(g.texto, g.citacoes).length}`);
}
console.log('tudo certo');
