// Testes rápidos sem Firebase: node teste.mjs
// Com GEMINI_API_KEY definido, também faz uma busca real no Gemini.
import assert from 'node:assert/strict';
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

const vs = await feedYoutube('UCPGuorlvarThSlwJpyTHOmQ');
assert.ok(vs.length > 0 && vs[0].id && vs[0].publicado);
console.log(`youtube: ok (${vs.length} vídeos; último: ${vs[0].titulo})`);

if (process.env.GEMINI_API_KEY) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const g = await gemini(process.env.GEMINI_API_KEY, `Hoje é ${hoje}. Pesquise no Google a notícia mais recente de Street Fighter 6 e responda numa linha:\nNOTICIA|AAAA-MM-DD|Título|Resumo`);
  console.log(`gemini: pesquisou=${g.pesquisou}, citações=${g.citacoes.length}, notícias=${parseNoticias(g.texto, g.citacoes).length}`);
}
console.log('tudo certo');
