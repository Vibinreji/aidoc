/**
 * aidoc CLI.
 *   aidoc build <source-dir> -o <file.ai.html> [--model-dir <dir>] [--pca <n|none>]
 *   aidoc inspect <file.ai.html> [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build, cspFor, prepareEmbedder, readBlocks, sha256b64, type Manifest } from '../../core/src/node/index.ts';

const HERE = import.meta.dirname;
const RUNTIME_DIST = resolve(HERE, '../../runtime/dist');
const CACHE = process.env.AIDOC_CACHE ?? join(homedir(), '.cache', 'aidoc');

/** Defaults per embedder, from benchmarks (docs/decisions.md D-09). */
const EMBEDDERS: Record<string, { license: string; pca: number | null; thresholds: { outOfScope: number; cosRef: number; faqMatch: number } }> = {
  'minishlab/potion-base-8M': { license: 'MIT', pca: 128, thresholds: { outOfScope: 0.55, cosRef: 0.3, faqMatch: 0.75 } },
};
const DEFAULT_MODEL = 'minishlab/potion-base-8M';
const MODEL_FILES = ['config.json', 'tokenizer.json', 'model.safetensors'];

function die(msg: string): never {
  console.error(`aidoc: ${msg}`);
  process.exit(1);
}

async function ensureModel(modelId: string, dir?: string): Promise<string> {
  if (dir) {
    for (const f of MODEL_FILES) if (!existsSync(join(dir, f))) die(`model dir ${dir} is missing ${f}`);
    return dir;
  }
  const target = join(CACHE, 'models', modelId.replace('/', '__'));
  if (MODEL_FILES.every((f) => existsSync(join(target, f)))) return target;
  // Build-time download (the built document never touches the network).
  mkdirSync(target, { recursive: true });
  console.error(`Downloading ${modelId} from huggingface.co (one time, build only)…`);
  for (const f of MODEL_FILES) {
    const res = await fetch(`https://huggingface.co/${modelId}/resolve/main/${f}`);
    if (!res.ok) die(`download failed for ${f}: HTTP ${res.status}`);
    writeFileSync(join(target, f), new Uint8Array(await res.arrayBuffer()));
  }
  return target;
}

function loadEmbedder(modelId: string, modelDir: string, pca: number | null): Uint8Array {
  const cacheFile = join(CACHE, 'embedders', `${modelId.replace('/', '__')}-${pca ?? 'full'}-${statSync(join(modelDir, 'model.safetensors')).size}.aide`);
  if (existsSync(cacheFile)) return new Uint8Array(readFileSync(cacheFile));
  const info = EMBEDDERS[modelId];
  const { payload } = prepareEmbedder({ modelDir, modelId, license: info?.license ?? 'unknown', pca });
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, payload);
  return payload;
}

function runtimeAssets() {
  const js = join(RUNTIME_DIST, 'runtime.js');
  if (!existsSync(js)) die('runtime is not built; run `pnpm build` first');
  return {
    version: JSON.parse(readFileSync(join(RUNTIME_DIST, 'runtime.json'), 'utf8')).version as string,
    js: readFileSync(js, 'utf8'),
    css: readFileSync(join(RUNTIME_DIST, 'style.css'), 'utf8'),
  };
}

async function cmdBuild(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string', short: 'o' }, 'model-dir': { type: 'string' }, model: { type: 'string' }, pca: { type: 'string' } },
  });
  const src = positionals[0] ?? die('usage: aidoc build <source-dir> -o <file.ai.html>');
  const out = values.out ?? die('missing -o <file.ai.html>');
  const modelId = values.model ?? DEFAULT_MODEL;
  const info = EMBEDDERS[modelId];
  if (!info) console.error(`warning: no calibrated thresholds for ${modelId}; using potion-base-8M defaults`);
  const pca = values.pca === undefined ? (info?.pca ?? null) : values.pca === 'none' ? null : Number(values.pca);
  const t0 = performance.now();
  const modelDir = await ensureModel(modelId, values['model-dir']);
  const payload = loadEmbedder(modelId, modelDir, pca);
  const res = build({
    sourceDir: resolve(src),
    embedderPayload: payload,
    embedderLicense: info?.license ?? 'unknown',
    runtime: runtimeAssets(),
    thresholds: (info ?? EMBEDDERS[DEFAULT_MODEL]!).thresholds,
  });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, res.html);
  for (const w of res.warnings) console.error(`warning: ${w}`);
  console.log(`Built ${out} (${(res.manifest.sizes.total / 1e6).toFixed(2)} MB, ${res.manifest.counts.chunks} chunks) in ${Math.round(performance.now() - t0)} ms`);
}

function sizeReport(m: Manifest): string {
  const rows: [string, number][] = [
    ['content (text + markup)', m.sizes.content],
    ['images', m.sizes.images],
    ['chunks', m.sizes.chunks],
    ['bm25 index', m.sizes.bm25],
    ['vectors', m.sizes.vectors],
    ['embedder', m.sizes.embedder],
    ['generated content', m.sizes.generated],
    ['concept graph', m.sizes.graph],
    ['runtime (js)', m.sizes.runtime],
    ['style (css)', m.sizes.style],
  ];
  const known = rows.reduce((a, [, b]) => a + b, 0);
  rows.push(['other (manifest, html)', m.sizes.total - known]);
  const w = Math.max(...rows.map(([k]) => k.length));
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`).padStart(10);
  return [
    `${'component'.padEnd(w)}  ${'size'.padStart(10)}  ${'share'.padStart(6)}`,
    ...rows.map(([k, v]) => `${k.padEnd(w)}  ${fmt(v)}  ${((100 * v) / m.sizes.total).toFixed(1).padStart(5)}%`),
    `${'total'.padEnd(w)}  ${fmt(m.sizes.total)}  100.0%`,
  ].join('\n');
}

function cmdInspect(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const file = positionals[0] ?? die('usage: aidoc inspect <file.ai.html>');
  const html = readFileSync(file, 'utf8');
  const blocks = readBlocks(html);
  const mb = blocks.get('aidoc-manifest') ?? die('no aidoc manifest found');
  const m = JSON.parse(mb.text) as Manifest;
  const issues: string[] = [];
  for (const [name, meta] of Object.entries(m.blocks)) {
    const b = blocks.get(`aidoc-${name}`);
    if (!b) issues.push(`block ${name} missing`);
    else if (sha256b64(b.text) !== meta.sha256) issues.push(`block ${name}: sha256 mismatch`);
  }
  const js = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html)?.[1] ?? '';
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
  if (csp !== cspFor(js, css)) issues.push('CSP does not match the runtime/style hashes or the text profile');
  if (sha256b64(js) !== m.runtime.sha256) issues.push('runtime sha256 does not match the manifest');
  const actual = Buffer.byteLength(html, 'utf8');
  if (values.json) {
    console.log(JSON.stringify({ file, manifest: m, actualBytes: actual, issues }, null, 2));
    return;
  }
  console.log(`${file}\n${m.title}`);
  console.log(`aidoc ${m.aidoc} · runtime ${m.runtime.version} · embedder ${m.embedder.id} (${m.embedder.license}, ${m.embedder.dims} dims int8${m.embedder.pca ? `, PCA ${m.embedder.pca}` : ''}, vocab ${m.embedder.vocabSize})`);
  console.log(`generated content: ${m.provenance.generatedContent} (by ${m.provenance.generatedBy}${m.provenance.model ? `, ${m.provenance.model}` : ''})`);
  console.log(`counts: ${m.sections.length} sections · ${m.counts.chunks} chunks · ${m.counts.faq} FAQ · ${m.counts.quiz} quiz items · ${m.counts.nodes} concepts · ${m.counts.edges} relations`);
  console.log(`thresholds: outOfScope ${m.thresholds.outOfScope} · cosRef ${(m.thresholds as { cosRef?: number }).cosRef} · faqMatch ${m.thresholds.faqMatch}\n`);
  console.log(sizeReport(m));
  console.log(`\nintegrity: ${issues.length ? issues.join('; ') : 'ok (block hashes, CSP hashes, runtime hash)'}${actual !== m.sizes.total ? ` · size mismatch: file is ${actual} bytes` : ''}`);
  if (issues.length) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'build') await cmdBuild(rest);
else if (cmd === 'inspect') cmdInspect(rest);
else {
  console.log('usage:\n  aidoc build <source-dir> -o <file.ai.html> [--model-dir <dir>] [--pca <n|none>]\n  aidoc inspect <file.ai.html> [--json]');
  process.exitCode = cmd ? 1 : 0;
}
