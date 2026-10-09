/** Read an .ai.html file back into its parts (for inspect, tests, calibration). Node only. */
import { gunzipSync } from 'node:zlib';
import { decodeEmbedder, StaticEmbedder } from '../embed/embedder.ts';

export interface RawBlock {
  id: string;
  type: string;
  attrs: Record<string, string>;
  text: string;
}

export function readBlocks(html: string): Map<string, RawBlock> {
  const out = new Map<string, RawBlock>();
  const re = /<script\s+([^>]*type="application\/[^"]*"[^>]*)>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    out.set(attrs.id!, { id: attrs.id!, type: attrs.type!, attrs, text: m[2]! });
  }
  return out;
}

export function decodeBytes(b: RawBlock): Uint8Array {
  const raw = Buffer.from(b.text, 'base64');
  return new Uint8Array(b.attrs['data-compression'] === 'gzip' ? gunzipSync(raw) : raw);
}

export function decodeJson<T>(b: RawBlock | undefined): T | null {
  if (!b) return null;
  if (b.attrs['data-encoding'] === 'base64') return JSON.parse(Buffer.from(decodeBytes(b)).toString('utf8')) as T;
  return JSON.parse(b.text) as T;
}

/** Everything the engine needs, decoded from a built file. */
export function loadEngineData(html: string) {
  const blocks = readBlocks(html);
  const manifest = decodeJson<any>(blocks.get('aidoc-manifest'))!;
  const v = blocks.get('aidoc-vectors');
  const e = blocks.get('aidoc-embedder');
  const vb = v ? decodeBytes(v) : null;
  return {
    manifest,
    chunks: decodeJson<any[]>(blocks.get('aidoc-chunks'))!,
    bm25: decodeJson<any>(blocks.get('aidoc-bm25'))!,
    vectors: vb ? new Int8Array(vb.buffer, vb.byteOffset, vb.byteLength) : null,
    embedder: e ? new StaticEmbedder(decodeEmbedder(decodeBytes(e))) : null,
    generated: decodeJson<any>(blocks.get('aidoc-generated')),
    graph: decodeJson<any>(blocks.get('aidoc-graph')),
  };
}
