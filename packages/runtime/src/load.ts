/**
 * Reading data blocks in the browser (spec §8, §15.1–15.2): verify the sha256 of the stored text,
 * enforce size limits before decoding, decode base64/gzip, JSON.parse only.
 */

export const LIMITS = {
  storedText: 20 * 1024 * 1024,
  jsonDecoded: 20 * 1024 * 1024,
  embedderDecoded: 48 * 1024 * 1024,
  chunks: 20_000,
  dims: 1024,
};

export class BlockError extends Error {}

export interface BlockMeta {
  sha256: string;
  bytes: number;
  encoding: 'json' | 'base64';
  compression: 'none' | 'gzip';
}

export function blockElement(id: string): HTMLScriptElement | null {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLScriptElement) || !el.type.startsWith('application/aidoc-')) return null;
  return el;
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export async function verify(text: string, expected: string | undefined): Promise<boolean | null> {
  if (!expected) throw new BlockError('missing integrity entry');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // spec §15.1.2: proceed without verification
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return bytesToBase64(digest) === expected;
}

export function base64ToBytes(text: string): Uint8Array {
  const from = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (from) return from(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new BlockError('decoded block exceeds the size limit');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface LoadedBlock {
  text: string;
  el: HTMLScriptElement;
  meta: BlockMeta;
  verified: boolean | null;
}

/** Read and verify a block's stored text. Returns null if the block is absent. */
export async function readBlock(id: string, meta: BlockMeta | undefined): Promise<LoadedBlock | null> {
  const el = blockElement(id);
  if (!el) return null;
  if (!meta) throw new BlockError('block is not listed in the manifest');
  const text = el.textContent ?? '';
  if (text.length > LIMITS.storedText) throw new BlockError('block exceeds the size limit');
  const verified = await verify(text, meta.sha256);
  if (verified === false) throw new BlockError('integrity check failed');
  return { text, el, meta, verified };
}

export async function decodeBytes(b: LoadedBlock, limit: number): Promise<Uint8Array> {
  if (b.meta.encoding !== 'base64') throw new BlockError('expected base64 block');
  const raw = base64ToBytes(b.text);
  if (b.meta.compression === 'gzip') return gunzip(raw, limit);
  if (raw.length > limit) throw new BlockError('decoded block exceeds the size limit');
  return raw;
}

export async function decodeJson<T>(b: LoadedBlock): Promise<T> {
  if (b.meta.encoding === 'json') return JSON.parse(b.text) as T;
  const bytes = await decodeBytes(b, LIMITS.jsonDecoded);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Yield to the event loop so loading never blocks input for long (spec §15.2.4). */
export const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));
