/**
 * Retrieval + threshold calibration in Node, using the exact runtime engine.
 * Usage: node benchmarks/calibrate.ts [pca...]   e.g.  node benchmarks/calibrate.ts full 128
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rank } from '../packages/core/src/search/bm25.ts';
import { ROOT, DEFAULT_THRESHOLDS, engineFor } from './lib.ts';

const evalSet = JSON.parse(readFileSync(join(ROOT, 'benchmarks/eval/transformer.json'), 'utf8'));

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const fmt = (x: number) => x.toFixed(3);

const variants = (process.argv.slice(2).length ? process.argv.slice(2) : ['full', '128']).map((v) => (v === 'full' ? null : Number(v)));
for (const pca of variants) {
  const { engine: eng, res } = engineFor(pca);
  const secOf = (ci: number) => eng.d.chunks[ci]!.sectionId;
  const hit = (order: number[], ok: string[], k: number) => order.slice(0, k).some((ci) => ok.includes(secOf(ci)));
  const m = { hyb1: 0, hyb3: 0, bm1: 0, bm3: 0, cos1: 0, cos3: 0 };
  const inCos: number[] = [];
  const faqIn: { q: string; score: number; cov: number; ok: boolean }[] = [];
  const misses: string[] = [];
  for (const it of evalSet.inScope) {
    const qv = eng.queryVector(it.q)!;
    const { order, cos, bm } = eng.retrieve(it.q, qv);
    const bmo = rank(bm, 0);
    const co = rank(cos!);
    m.hyb1 += +hit(order, it.sections, 1);
    m.hyb3 += +hit(order, it.sections, 3);
    m.bm1 += +hit(bmo, it.sections, 1);
    m.bm3 += +hit(bmo, it.sections, 3);
    m.cos1 += +hit(co, it.sections, 1);
    m.cos3 += +hit(co, it.sections, 3);
    if (!hit(order, it.sections, 3)) misses.push(`${it.q} → ${order.slice(0, 3).map(secOf).join(', ')}`);
    inCos.push(eng.bestCos(qv)!);
    const f = eng.matchFaq(it.q, qv)!;
    faqIn.push({ q: it.q, score: f.score, cov: f.coverage, ok: f.faq.sourceSectionIds.some((s: string) => it.sections.includes(s)) });
  }
  const oos = evalSet.outOfScope.map((o: { q: string; kind: string }) => {
    const qv = eng.queryVector(o.q)!;
    const f = eng.matchFaq(o.q, qv)!;
    return { ...o, cos: eng.bestCos(qv)!, faq: f.score, cov: f.coverage, faqQ: f.faq.question };
  });
  const n = evalSet.inScope.length;
  const h = res.manifest.sizes;
  console.log(`\n=== potion-base-8M ${pca ?? 'full (256)'} dims — embedder ${(h.embedder / 1e6).toFixed(2)} MB in-file, total ${(h.total / 1e6).toFixed(2)} MB`);
  console.log(`retrieval (n=${n})  hybrid hit@1 ${m.hyb1}/${n} hit@3 ${m.hyb3}/${n} | bm25 ${m.bm1}/${m.bm3} | cosine ${m.cos1}/${m.cos3}`);
  if (misses.length) console.log('  hybrid misses@3:\n   ' + misses.join('\n   '));
  console.log(`bestCos in-scope: min ${fmt(Math.min(...inCos))} p05 ${fmt(pct(inCos, 0.05))} p10 ${fmt(pct(inCos, 0.1))} median ${fmt(pct(inCos, 0.5))}`);
  const far = oos.filter((o: any) => o.kind === 'far').map((o: any) => o.cos);
  const near = oos.filter((o: any) => o.kind === 'near').map((o: any) => o.cos);
  console.log(`bestCos OOS far:  max ${fmt(Math.max(...far))} median ${fmt(pct(far, 0.5))} | near: max ${fmt(Math.max(...near))} median ${fmt(pct(near, 0.5))}`);
  console.log('  OOS detail: ' + oos.map((o: any) => `${fmt(o.cos)} ${o.q}`).sort().reverse().slice(0, 8).join('\n              '));
  console.log('  lowest in-scope: ' + evalSet.inScope.map((it: any, i: number) => `${fmt(inCos[i]!)} ${it.q}`).sort().slice(0, 6).join('\n                   '));
  for (const t of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
    const rej = (xs: number[]) => xs.filter((x) => x < t).length;
    console.log(`  t=${t}: in-scope kept ${n - rej(inCos)}/${n}, far rejected ${rej(far)}/${far.length}, near rejected ${rej(near)}/${near.length}`);
  }
  const inScore = evalSet.inScope.map((it: any) => eng.scopeScore(it.q));
  const oosScore = oos.map((o: any) => ({ ...o, s: eng.scopeScore(o.q) }));
  const t = DEFAULT_THRESHOLDS.outOfScope;
  console.log(`COMBINED rule (score = coverage × min(1, cos/${DEFAULT_THRESHOLDS.cosRef}), OOS if < ${t}): in-scope kept ${inScore.filter((x: number) => x >= t).length}/${n}, far rejected ${oosScore.filter((o: any) => o.kind === 'far' && o.s < t).length}/${far.length}, near rejected ${oosScore.filter((o: any) => o.kind === 'near' && o.s < t).length}/${near.length}`);
  console.log('  false rejects: ' + evalSet.inScope.filter((_: any, i: number) => inScore[i] < t).map((it: any, i: number) => it.q).join(' | '));
  console.log('  accepted OOS:  ' + oosScore.filter((o: any) => o.s >= t).map((o: any) => `${o.s.toFixed(2)} ${o.q}`).join(' | '));
  const fa = faqIn.filter((f) => f.score >= DEFAULT_THRESHOLDS.faqMatch && f.cov >= 0.5);
  console.log(`FAQ @${DEFAULT_THRESHOLDS.faqMatch}+cov≥0.5: answered ${fa.length}/${n}, wrong source ${fa.filter((f) => !f.ok).length}; OOS FAQ hits ${oos.filter((o: any) => o.faq >= DEFAULT_THRESHOLDS.faqMatch && o.cov >= 0.5).length}`);
  console.log(`FAQ best score in-scope: ${faqIn.map((f) => `${fmt(f.score)}${f.ok ? '' : '✗'}/${f.cov.toFixed(1)}`).sort().reverse().join(' ')}`);
  console.log(`FAQ best score OOS:      ${oos.map((o: any) => `${fmt(o.faq)}/${o.cov.toFixed(1)}`).sort().reverse().join(' ')}`);
  const wrongHigh = faqIn.filter((f) => !f.ok && f.cov >= 0.5).sort((a, b) => b.score - a.score).slice(0, 5);
  console.log('  highest wrong FAQ matches (cov≥0.5): ' + wrongHigh.map((f) => `${fmt(f.score)} ${f.q}`).join(' | '));
}
