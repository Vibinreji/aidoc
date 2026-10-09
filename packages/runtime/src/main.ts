/**
 * aidoc runtime entry point. Builds the panel, then loads data in two stages so the panel is
 * usable quickly: (1) text blocks → keyword search, generated content, graph; (2) vectors and
 * the embedder → semantic search. Any failure leaves the document readable (spec §15.2).
 */
import { decodeEmbedder, StaticEmbedder } from '@aidoc/core/src/embed/embedder.ts';
import type { Bm25Block } from '@aidoc/core/src/search/bm25.ts';
import { buildBm25 } from '@aidoc/core/src/search/bm25.ts';
import type { ConceptGraph, GeneratedContent } from '@aidoc/core/src/node/references.ts';
import { Engine, type Chunk, type EngineData, type ManifestLike } from './engine.ts';
import { BlockError, LIMITS, blockElement, decodeBytes, decodeJson, readBlock, yieldToMain, type BlockMeta } from './load.ts';
import { Panel } from './panel.ts';

interface Manifest extends ManifestLike {
  aidoc: string;
  blocks: Record<string, BlockMeta>;
  embedder: { dims: number };
}

declare global {
  interface Window {
    __aidoc?: { engine?: Engine; timings: Record<string, number>; errors: string[] };
  }
}

const timings: Record<string, number> = {};
const errors: string[] = [];
const mark = (k: string) => (timings[k] = Math.round(performance.now()));
window.__aidoc = { timings, errors };

async function optional<T>(name: string, id: string, m: Manifest, what: string): Promise<T | null> {
  try {
    const b = await readBlock(id, m.blocks[name]);
    return b ? await decodeJson<T>(b) : null;
  } catch (e) {
    errors.push(`${name}: ${(e as Error).message}`);
    console.warn(`aidoc: ${what} unavailable:`, e);
    return null;
  }
}

async function boot(): Promise<void> {
  mark('start');
  const panel = new Panel();
  let manifest: Manifest;
  try {
    const el = blockElement('aidoc-manifest');
    if (!el) throw new BlockError('manifest missing');
    manifest = JSON.parse(el.textContent ?? '') as Manifest;
    if (manifest.aidoc !== '0.1') throw new BlockError(`unsupported format version ${manifest.aidoc}`);
  } catch (e) {
    errors.push(`manifest: ${(e as Error).message}`);
    panel.fail('The question panel is unavailable because this file is damaged. The document itself is unaffected.');
    return;
  }

  // Stage 1: text blocks.
  let chunks: Chunk[];
  try {
    const b = await readBlock('aidoc-chunks', manifest.blocks.chunks);
    if (!b) throw new BlockError('chunks missing');
    chunks = await decodeJson<Chunk[]>(b);
    if (!Array.isArray(chunks) || chunks.length > LIMITS.chunks || chunks.length !== manifest.counts.chunks) throw new BlockError('chunks malformed');
  } catch (e) {
    errors.push(`chunks: ${(e as Error).message}`);
    panel.fail('The question panel is unavailable because its search data is damaged. The document itself is unaffected.');
    return;
  }
  await yieldToMain();
  const bm25 =
    (await optional<Bm25Block>('bm25', 'aidoc-bm25', manifest, 'keyword index')) ??
    buildBm25(chunks.map((c) => `${c.headingPath.join('\n')}\n\n${c.text}`), manifest.language);
  const generated = await optional<GeneratedContent>('generated', 'aidoc-generated', manifest, 'prepared content');
  const graph = await optional<ConceptGraph>('graph', 'aidoc-graph', manifest, 'concept map');
  const base: EngineData = { manifest, chunks, bm25, vectors: null, embedder: null, generated, graph };
  let engine = new Engine(base);
  const notes: string[] = [];
  if (!generated && manifest.blocks.generated) notes.push('Summaries and quizzes are unavailable because their data is damaged.');
  if (!graph && manifest.blocks.graph) notes.push('The concept map is unavailable because its data is damaged.');
  panel.setEngine(engine, ['Loading semantic search…', ...notes].join(' '));
  window.__aidoc!.engine = engine;
  mark('textReady');

  // Stage 2: vectors + embedder.
  await yieldToMain();
  try {
    const vb = await readBlock('aidoc-vectors', manifest.blocks.vectors);
    const eb = await readBlock('aidoc-embedder', manifest.blocks.embedder);
    if (!vb || !eb) throw new BlockError('vector data missing');
    const dims = Number(vb.el.dataset.dims);
    const rows = Number(vb.el.dataset.rows);
    if (!(dims > 0 && dims <= LIMITS.dims) || rows !== manifest.counts.chunks + manifest.counts.faq || dims !== manifest.embedder.dims) throw new BlockError('vector header mismatch');
    const vbytes = await decodeBytes(vb, rows * dims);
    if (vbytes.length !== rows * dims) throw new BlockError('vector length mismatch');
    await yieldToMain();
    const ebytes = await decodeBytes(eb, LIMITS.embedderDecoded);
    await yieldToMain();
    const embedder = new StaticEmbedder(decodeEmbedder(ebytes));
    if (embedder.dims !== dims) throw new BlockError('embedder dims mismatch');
    engine = new Engine({ ...base, vectors: new Int8Array(vbytes.buffer, vbytes.byteOffset, vbytes.byteLength), embedder });
    window.__aidoc!.engine = engine;
    panel.setEngine(engine, notes.join(' '));
  } catch (e) {
    errors.push(`vectors: ${(e as Error).message}`);
    panel.setEngine(engine, ['Semantic search is unavailable because the embedding data is damaged. Keyword search still works.', ...notes].join(' '));
  }
  mark('ready');
}

boot().catch((e) => {
  errors.push(`boot: ${(e as Error).message}`);
  console.error('aidoc:', e);
});
