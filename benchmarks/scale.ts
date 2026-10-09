/**
 * Scale check: a synthetic ~300-page document (the example repeated), built with the real
 * runtime, then timed in Chromium/Firefox/WebKit via Playwright. Usage: node benchmarks/scale.ts [copies]
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { build } from '../packages/core/src/node/index.ts';
import { ROOT, DEFAULT_THRESHOLDS, embedderPayload } from './lib.ts';

const copies = Number(process.argv[2] ?? 25);
const src = readFileSync(join(ROOT, 'examples/transformer/document.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '').replace(/^# .*$/m, '');
let md = '---\ntitle: Scale test\nlanguage: en\ncreated: 2026-10-09\n---\n\n# Scale test\n';
for (let i = 0; i < copies; i++) md += src.replace(/\{#([a-z0-9-]+)\}/g, `{#$1-${i}}`).replace(/^## (.*?) \{/gm, `## Part ${i + 1}: $1 {`);
const dir = mkdtempSync(join(tmpdir(), 'aidoc-scale-'));
writeFileSync(join(dir, 'document.md'), md);
const rt = join(ROOT, 'packages/runtime/dist');
const t0 = performance.now();
const res = build({ sourceDir: dir, embedderPayload: embedderPayload(128), embedderLicense: 'MIT', runtime: { version: '0.1.0', js: readFileSync(join(rt, 'runtime.js'), 'utf8'), css: readFileSync(join(rt, 'style.css'), 'utf8') }, thresholds: DEFAULT_THRESHOLDS });
const words = md.split(/\s+/).length;
writeFileSync(join(dir, 'scale.ai.html'), res.html);
console.log(`built ${words} words (~${Math.round(words / 400)} pages), ${res.manifest.counts.chunks} chunks, ${(res.manifest.sizes.total / 1e6).toFixed(2)} MB in ${Math.round(performance.now() - t0)} ms`);

const queries = ['What is self-attention?', 'how big is the kv cache', 'rotary position embedding', 'why divide by sqrt d_k', 'mixture of experts router', 'layer normalization placement'];
for (const [name, bt] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] as const) {
  const browser = await bt.launch(name === 'firefox' ? { firefoxUserPrefs: { 'security.fileuri.strict_origin_policy': true } } : {});
  const page = await browser.newPage();
  const tNav = Date.now();
  await page.goto(pathToFileURL(join(dir, 'scale.ai.html')).href);
  await page.waitForFunction(() => (window as any).__aidoc?.timings?.ready, null, { timeout: 60_000 });
  const openToReady = Date.now() - tNav;
  const r = await page.evaluate((qs) => {
    const e = (window as any).__aidoc.engine;
    const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
    for (const q of qs) e.search(q); // warm
    const search = qs.map((q) => time(() => e.search(q)));
    const ask = qs.map((q) => time(() => e.ask(q)));
    const mem = (performance as any).memory?.usedJSHeapSize;
    return { search, ask, mem };
  }, queries);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(1);
  const max = (xs: number[]) => Math.max(...xs).toFixed(1);
  console.log(`${name.padEnd(9)} open→ready ${openToReady} ms | search median ${med(r.search)} ms, max ${max(r.search)} ms | ask median ${med(r.ask)} ms, max ${max(r.ask)} ms${r.mem ? ` | JS heap ${(r.mem / 1e6).toFixed(0)} MB` : ''}`);
  await browser.close();
}
