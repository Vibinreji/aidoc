/**
 * Static embedder (spec §13): binary format "aidoc-embedder-v1" and the
 * embedding algorithm (§13.4). Browser-safe.
 */
import { WordPieceTokenizer, type TokenizerConfig } from '../text/tokenizer.ts';

export interface EmbedderHeader {
  format: 'aidoc-embedder-v1';
  model: string;
  license: string;
  dims: number;
  rows: number;
  pca: number | null;
  tokenizer: { type: 'bert-wordpiece' } & TokenizerConfig;
  rowMap?: number[];
  pooling: { dropUnk: true; specialTokens: false; maxTokens: number; method: 'mean'; normalize: 'l2' };
}

const MAGIC = [0x41, 0x49, 0x44, 0x45]; // "AIDE"

export const LIMITS = { maxDims: 1024, maxVocab: 100_000, maxHeaderBytes: 4 * 1024 * 1024 };

// ---- float16 ----------------------------------------------------------------

export function f16ToF32(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** Round-to-nearest-even float32 → float16 bits. */
export function f32ToF16(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let r = m >> shift;
    if ((m >> (shift - 1)) & 1 && ((m & ((1 << (shift - 1)) - 1)) || r & 1)) r++;
    return sign | r;
  }
  let r = m >> 13;
  if (m & 0x1000 && (m & 0xfff || r & 1)) {
    r++;
    if (r === 0x400) {
      r = 0;
      e++;
      if (e >= 31) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | r;
}

// ---- binary format ----------------------------------------------------------

export interface EmbedderData {
  header: EmbedderHeader;
  matrix: Int8Array; // rows × dims
  scales: Float32Array; // rows
}

export function encodeEmbedder(d: EmbedderData): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(d.header));
  const pad = (4 - ((8 + headerBytes.length) % 4)) % 4;
  const m = 8 + headerBytes.length + pad;
  const { rows, dims } = d.header;
  const out = new Uint8Array(m + rows * dims + 2 * rows);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, headerBytes.length, true);
  out.set(headerBytes, 8);
  out.set(new Uint8Array(d.matrix.buffer, d.matrix.byteOffset, rows * dims), m);
  const dv = new DataView(out.buffer);
  for (let r = 0; r < rows; r++) dv.setUint16(m + rows * dims + 2 * r, f32ToF16(d.scales[r]!), true);
  return out;
}

export function decodeEmbedder(bytes: Uint8Array): EmbedderData {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('embedder: bad magic');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = dv.getUint32(4, true);
  if (hl > LIMITS.maxHeaderBytes || 8 + hl > bytes.length) throw new Error('embedder: bad header length');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as EmbedderHeader;
  if (header.format !== 'aidoc-embedder-v1') throw new Error('embedder: unknown format');
  const { rows, dims } = header;
  const vocabLen = header.tokenizer?.vocab?.length ?? 0;
  if (!(dims > 0 && dims <= LIMITS.maxDims) || !(vocabLen > 0 && vocabLen <= LIMITS.maxVocab) || !(rows > 0 && rows <= vocabLen)) {
    throw new Error('embedder: header out of limits');
  }
  if (header.rowMap ? header.rowMap.length !== vocabLen : rows !== vocabLen) throw new Error('embedder: rowMap mismatch');
  const m = 8 + hl + ((4 - ((8 + hl) % 4)) % 4);
  if (bytes.length !== m + rows * dims + 2 * rows) throw new Error('embedder: payload length mismatch');
  const matrix = new Int8Array(bytes.buffer, bytes.byteOffset + m, rows * dims);
  const scales = new Float32Array(rows);
  const so = m + rows * dims;
  for (let r = 0; r < rows; r++) scales[r] = f16ToF32(dv.getUint16(so + 2 * r, true));
  return { header, matrix, scales };
}

// ---- embedding --------------------------------------------------------------

export class StaticEmbedder {
  readonly tokenizer: WordPieceTokenizer;
  readonly dims: number;
  private readonly d: EmbedderData;

  constructor(d: EmbedderData) {
    this.d = d;
    this.dims = d.header.dims;
    this.tokenizer = new WordPieceTokenizer(d.header.tokenizer);
  }

  get header(): EmbedderHeader {
    return this.d.header;
  }

  private row(id: number): number {
    const map = this.d.header.rowMap;
    return map ? map[id]! : id;
  }

  /** Embed pre-tokenized ids (§13.4 steps 2–5). Returns an L2-normalized vector (or zeros). */
  embedIds(ids: readonly number[]): Float32Array {
    const { dims } = this;
    const out = new Float32Array(dims);
    const max = this.d.header.pooling.maxTokens;
    const unk = this.tokenizer.unkId;
    let n = 0;
    for (const id of ids) {
      if (n >= max) break;
      if (id === unk) continue;
      const r = this.row(id);
      if (r < 0) continue;
      const s = this.d.scales[r]!;
      const off = r * dims;
      const m = this.d.matrix;
      for (let k = 0; k < dims; k++) out[k]! += m[off + k]! * s;
      n++;
    }
    if (n === 0) return out;
    let norm = 0;
    for (let k = 0; k < dims; k++) norm += out[k]! * out[k]!;
    norm = Math.sqrt(norm);
    if (norm === 0) return out;
    for (let k = 0; k < dims; k++) out[k]! /= norm; // the mean's 1/n cancels under L2 normalization
    return out;
  }

  embed(text: string): Float32Array {
    return this.embedIds(this.tokenizer.encode(text));
  }

  private rowNorms: Float32Array | null = null;

  /**
   * Importance of a word: the largest row norm among its tokens. model2vec bakes Zipf
   * weighting into row norms, so rare (informative) words have larger norms. 0 if no vector.
   */
  wordWeight(word: string): number {
    if (!this.rowNorms) {
      const { rows, dims } = this.d.header;
      const m = this.d.matrix;
      this.rowNorms = new Float32Array(rows);
      for (let r = 0; r < rows; r++) {
        let s = 0;
        for (let k = 0; k < dims; k++) s += m[r * dims + k]! * m[r * dims + k]!;
        this.rowNorms[r] = Math.sqrt(s) * this.d.scales[r]!;
      }
    }
    let w = 0;
    for (const id of this.tokenizer.encode(word)) {
      if (id === this.tokenizer.unkId) continue;
      const r = this.row(id);
      if (r >= 0) w = Math.max(w, this.rowNorms[r]!);
    }
    return w;
  }
}

// ---- quantized vectors (spec §12) -------------------------------------------

export function quantize(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i]! * 127;
    const r = Math.sign(x) * Math.round(Math.abs(x)); // round half away from zero
    q[i] = Math.max(-127, Math.min(127, r));
  }
  return q;
}

/** Approximate cosine of float query q with every int8 row: dot(q, row) / 127. */
export function cosineAll(q: Float32Array, rows: Int8Array, dims: number, from = 0, to = rows.length / dims): Float32Array {
  const out = new Float32Array(to - from);
  for (let r = from; r < to; r++) {
    let s = 0;
    const off = r * dims;
    for (let k = 0; k < dims; k++) s += q[k]! * rows[off + k]!;
    out[r - from] = s / 127;
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
