/**
 * Build an .ai.html file (spec §3–§14) from a source directory:
 *   document.md (required), generated.json (optional), graph.json (optional).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { toHtml } from 'hast-util-to-html';
import type { Element } from 'hast';
import { StaticEmbedder, decodeEmbedder, quantize } from '../embed/embedder.ts';
import { buildBm25 } from '../search/bm25.ts';
import { chunkDocument, indexText, parseMarkdown, type ChunkModel, type DocumentModel } from './document.ts';
import { checkReferences, type GeneratedContent, type ConceptGraph } from './references.ts';

export const FORMAT_VERSION = '0.1';

export interface RuntimeAssets {
  version: string;
  js: string;
  css: string;
}

export interface BuildOptions {
  sourceDir: string;
  embedderPayload: Uint8Array;
  embedderLicense: string;
  runtime: RuntimeAssets;
  thresholds: { outOfScope: number; cosRef: number; faqMatch: number };
  /** Use gzip for a base64 block only if it saves at least this fraction. */
  gzipMinSaving?: number;
}

export interface BuildResult {
  html: string;
  manifest: Manifest;
  warnings: string[];
  chunks: ChunkModel[];
  doc: DocumentModel;
}

export interface Manifest {
  aidoc: string;
  title: string;
  language: string;
  created: string;
  authors?: string[];
  license?: string;
  runtime: { version: string; sha256: string };
  csp: { profile: 'text' };
  embedder: { id: string; license: string; dims: number; dtype: 'int8'; vocabSize: number; pca: number | null; sha256: string };
  privacy: { offlineRequired: true; allowCloudAI: boolean };
  provenance: { generatedContent: 'none' | 'author-reviewed' | 'unreviewed'; generatedBy: string; model?: string; generatedAt?: string };
  sections: { id: string; title: string; level: number }[];
  counts: { chunks: number; faq: number; quiz: number; nodes: number; edges: number };
  blocks: Record<string, { sha256: string; bytes: number; encoding: 'json' | 'base64'; compression: 'none' | 'gzip' }>;
  sizes: Record<'content' | 'images' | 'chunks' | 'bm25' | 'vectors' | 'embedder' | 'generated' | 'graph' | 'runtime' | 'style' | 'total', number>;
  thresholds: { outOfScope: number; cosRef: number; faqMatch: number };
}

export const sha256b64 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('base64');
const utf8len = (s: string) => Buffer.byteLength(s, 'utf8');
/** JSON for an inert data block: no "<" anywhere (spec §8.1.4). */
export const blockJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

export function cspFor(runtimeJs: string, css: string): string {
  return `default-src 'none'; script-src 'sha256-${sha256b64(runtimeJs)}'; style-src 'sha256-${sha256b64(css)}'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;
}

interface DataBlock {
  name: string; // manifest key
  id: string;
  type: string;
  text: string;
  attrs: Record<string, string>;
  encoding: 'json' | 'base64';
  compression: 'none' | 'gzip';
}

function binaryBlock(name: string, id: string, type: string, bytes: Uint8Array, minSaving: number, extra: Record<string, string> = {}): DataBlock {
  const gz = gzipSync(bytes, { level: 9 });
  const useGz = gz.length <= bytes.length * (1 - minSaving);
  const text = Buffer.from(useGz ? gz : bytes).toString('base64');
  const compression = useGz ? 'gzip' : 'none';
  return { name, id, type, text, encoding: 'base64', compression, attrs: { 'data-encoding': 'base64', 'data-compression': compression, ...extra, 'data-sha256': sha256b64(text) } };
}

function jsonBlock(name: string, id: string, type: string, value: unknown): DataBlock {
  return { name, id, type, text: blockJson(value), encoding: 'json', compression: 'none', attrs: {} };
}

function renderBlock(b: DataBlock): string {
  const attrs = Object.entries(b.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  return `<script type="${b.type}" id="${b.id}"${attrs}>${b.text}</script>`;
}

export function build(o: BuildOptions): BuildResult {
  const minSaving = o.gzipMinSaving ?? 0.05;
  const doc = parseMarkdown(join(o.sourceDir, 'document.md'));
  const warnings = [...doc.warnings];
  const readJson = <T>(f: string): T | undefined => (existsSync(join(o.sourceDir, f)) ? (JSON.parse(readFileSync(join(o.sourceDir, f), 'utf8')) as T) : undefined);
  const generated = readJson<GeneratedContent>('generated.json');
  const graph = readJson<ConceptGraph>('graph.json');
  const refErrors = checkReferences(doc.sections.map((s) => s.id), generated, graph);
  if (refErrors.length) throw new Error(`invalid references:\n  ${refErrors.join('\n  ')}`);

  const embedderData = decodeEmbedder(o.embedderPayload);
  const embedder = new StaticEmbedder(embedderData);
  const chunks = chunkDocument(doc, { countTokens: (s) => embedder.tokenizer.encode(s).length, language: doc.meta.language });
  const faq = generated?.faq ?? [];

  // Vectors: chunk rows then FAQ question rows (spec §12.2).
  const dims = embedderData.header.dims;
  const rows = chunks.length + faq.length;
  const vectors = new Int8Array(rows * dims);
  chunks.forEach((c, i) => vectors.set(quantize(embedder.embed(indexText(c))), i * dims));
  faq.forEach((f, j) => vectors.set(quantize(embedder.embed(f.question)), (chunks.length + j) * dims));

  const bm25 = buildBm25(chunks.map(indexText), doc.meta.language);

  const blocks: DataBlock[] = [
    jsonBlock('chunks', 'aidoc-chunks', 'application/aidoc-chunks+json', chunks),
    jsonBlock('bm25', 'aidoc-bm25', 'application/aidoc-bm25+json', bm25),
    binaryBlock('vectors', 'aidoc-vectors', 'application/aidoc-vectors', new Uint8Array(vectors.buffer), minSaving, {
      'data-dtype': 'int8',
      'data-dims': String(dims),
      'data-rows': String(rows),
    }),
    binaryBlock('embedder', 'aidoc-embedder', 'application/aidoc-embedder', o.embedderPayload, minSaving),
  ];
  if (generated) blocks.push(jsonBlock('generated', 'aidoc-generated', 'application/aidoc-generated+json', generated));
  if (graph) blocks.push(jsonBlock('graph', 'aidoc-graph', 'application/aidoc-graph+json', graph));
  // data-sha256 on JSON blocks too, so the runtime can verify before parsing.
  for (const b of blocks) b.attrs['data-sha256'] ??= sha256b64(b.text);

  // Content
  const main: Element = {
    type: 'element',
    tagName: 'main',
    properties: { id: 'aidoc-content' },
    children: doc.sections.map((s) => ({
      type: 'element',
      tagName: 'section',
      properties: { dataAidocId: s.id, dataAidocType: s.type },
      children: s.children,
    })),
  };
  const contentHtml = toHtml(main, { allowDangerousHtml: false });
  const images = [...contentHtml.matchAll(/data:image\/[^"'\s)]+/g)].reduce((a, m) => a + m[0].length, 0);

  const { js, css } = o.runtime;
  if (/<\/script|<!--/i.test(js)) throw new Error('runtime contains </script or <!--');
  if (/<\/style/i.test(css)) throw new Error('style contains </style');

  const quizCount = Object.values(generated?.sections ?? {}).reduce((a, s) => a + (s.quiz?.length ?? 0), 0);
  const hasGenerated = !!generated && (faq.length > 0 || Object.values(generated.sections ?? {}).some((s) => s.summary || s.simpleExplanation || s.keyPoints?.length || s.quiz?.length));
  const h = embedderData.header;
  const manifest: Manifest = {
    aidoc: FORMAT_VERSION,
    title: doc.meta.title,
    language: doc.meta.language,
    created: doc.meta.created,
    ...(doc.meta.authors ? { authors: doc.meta.authors } : {}),
    ...(doc.meta.license ? { license: doc.meta.license } : {}),
    runtime: { version: o.runtime.version, sha256: sha256b64(js) },
    csp: { profile: 'text' },
    embedder: { id: h.model, license: o.embedderLicense, dims, dtype: 'int8', vocabSize: h.tokenizer.vocab.length, pca: h.pca, sha256: sha256b64(o.embedderPayload) },
    privacy: { offlineRequired: true, allowCloudAI: false },
    provenance: {
      generatedContent: !hasGenerated ? 'none' : generated!.provenance.reviewed ? 'author-reviewed' : 'unreviewed',
      generatedBy: generated?.provenance.generatedBy ?? `aidoc ${o.runtime.version}`,
      ...(generated?.provenance.model ? { model: generated.provenance.model } : {}),
      ...(generated?.provenance.created ? { generatedAt: generated.provenance.created } : {}),
    },
    sections: doc.sections.map((s) => ({ id: s.id, title: s.title, level: s.level })),
    counts: { chunks: chunks.length, faq: faq.length, quiz: quizCount, nodes: graph?.nodes.length ?? 0, edges: graph?.edges.length ?? 0 },
    blocks: Object.fromEntries(blocks.map((b) => [b.name, { sha256: sha256b64(b.text), bytes: utf8len(b.text), encoding: b.encoding, compression: b.compression }])),
    sizes: { content: utf8len(contentHtml) - images, images, chunks: 0, bm25: 0, vectors: 0, embedder: 0, generated: 0, graph: 0, runtime: utf8len(js), style: utf8len(css), total: 0 },
    thresholds: o.thresholds,
  };
  for (const b of blocks) manifest.sizes[b.name as keyof Manifest['sizes']] = utf8len(b.text);

  const render = (m: Manifest, pad = '') =>
    '<!DOCTYPE html>\n' +
    `<html lang="${escAttr(doc.meta.language)}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${cspFor(js, css)}">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="generator" content="aidoc ${escAttr(o.runtime.version)}">\n` +
    `<title>${escText(doc.meta.title)}</title>\n<style>${css}</style>\n</head>\n<body>\n` +
    `${contentHtml}\n` +
    `<script type="application/aidoc-manifest+json" id="aidoc-manifest">${blockJson(m)}${pad}</script>\n` +
    blocks.map(renderBlock).join('\n') +
    `\n<script>${js}</script>\n</body>\n</html>\n`;

  // Fixed point for sizes.total (spec §9): iterate, then pad with spaces if needed.
  let html = render(manifest);
  for (let i = 0; i < 5; i++) {
    const len = utf8len(html);
    if (manifest.sizes.total === len) break;
    manifest.sizes.total = len;
    html = render(manifest);
  }
  const diff = manifest.sizes.total - utf8len(html);
  if (diff > 0) html = render(manifest, ' '.repeat(diff));
  else if (diff < 0) {
    manifest.sizes.total = utf8len(html) + 1;
    html = render(manifest);
    html = render(manifest, ' '.repeat(manifest.sizes.total - utf8len(html)));
  }
  return { html, manifest, warnings, chunks, doc };
}
