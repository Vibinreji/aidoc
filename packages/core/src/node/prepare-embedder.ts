/**
 * Build-time: convert a Hugging Face model2vec model directory (model.safetensors +
 * tokenizer.json + config.json) into the aidoc embedder payload (spec §13).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEmbedder, f16ToF32, f32ToF16, type EmbedderData, type EmbedderHeader } from '../embed/embedder.ts';

export interface PrepareOptions {
  modelDir: string;
  modelId: string;
  license: string;
  /** Reduce to this many dims with (uncentered) PCA. null = keep. */
  pca?: number | null;
}

export function readSafetensorsF32(path: string, name: string): { data: Float32Array; shape: number[] } {
  const buf = readFileSync(path);
  const n = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + n).toString('utf8')) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const t = header[name];
  if (!t) throw new Error(`tensor ${name} not found in ${path}`);
  if (t.dtype !== 'F32') throw new Error(`expected F32, got ${t.dtype}`);
  const [a, b] = t.data_offsets;
  const bytes = buf.subarray(8 + n + a, 8 + n + b);
  const copy = new Uint8Array(bytes); // aligned copy
  return { data: new Float32Array(copy.buffer, 0, (b - a) / 4), shape: t.shape };
}

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Returns eigenvectors as columns, sorted by eigenvalue desc. */
export function symmetricEigen(A: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p * n + p]!;
        const aqq = a[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]!;
          const akq = a[k * n + q]!;
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]!;
          const aqk = a[q * n + k]!;
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!;
          const vkq = v[k * n + q]!;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y * n + y]! - a[x * n + x]!);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((src, dst) => {
    values[dst] = a[src * n + src]!;
    for (let k = 0; k < n; k++) vectors[k * n + dst] = v[k * n + src]!;
  });
  return { values, vectors };
}

/**
 * Uncentered PCA: project rows onto the top-k eigenvectors of EᵀE. Uncentered so that the
 * mean direction (shared by all tokens) is kept; row norms (Zipf weights) are approximately preserved.
 */
export function pcaReduce(E: Float32Array, rows: number, dims: number, k: number): Float32Array {
  const C = new Float64Array(dims * dims);
  const row = new Float64Array(dims);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < dims; i++) row[i] = E[r * dims + i]!;
    for (let i = 0; i < dims; i++) {
      const ri = row[i]!;
      if (ri === 0) continue;
      const base = i * dims;
      for (let j = i; j < dims; j++) C[base + j]! += ri * row[j]!;
    }
  }
  for (let i = 0; i < dims; i++) for (let j = 0; j < i; j++) C[i * dims + j] = C[j * dims + i]!;
  const { vectors } = symmetricEigen(C, dims);
  const out = new Float32Array(rows * k);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < k; c++) {
      let s = 0;
      for (let i = 0; i < dims; i++) s += E[r * dims + i]! * vectors[i * dims + c]!;
      out[r * k + c] = s;
    }
  }
  return out;
}

/** Per-row symmetric int8 quantization with a float16 scale (rounded before quantizing). */
export function quantizeRows(E: Float32Array, rows: number, dims: number): { matrix: Int8Array; scales: Float32Array } {
  const matrix = new Int8Array(rows * dims);
  const scales = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let i = 0; i < dims; i++) max = Math.max(max, Math.abs(E[r * dims + i]!));
    const s = f16ToF32(f32ToF16(max / 127)) || 1e-8;
    scales[r] = f16ToF32(f32ToF16(s));
    for (let i = 0; i < dims; i++) {
      const q = Math.round(E[r * dims + i]! / s);
      matrix[r * dims + i] = Math.max(-127, Math.min(127, q));
    }
  }
  return { matrix, scales };
}

export function prepareEmbedder(o: PrepareOptions): { payload: Uint8Array; data: EmbedderData; floatMatrix: Float32Array } {
  const tok = JSON.parse(readFileSync(join(o.modelDir, 'tokenizer.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(o.modelDir, 'config.json'), 'utf8'));
  if (tok.model?.type !== 'WordPiece') throw new Error(`unsupported tokenizer model ${tok.model?.type}`);
  if (tok.normalizer?.type !== 'BertNormalizer' || tok.pre_tokenizer?.type !== 'BertPreTokenizer') {
    throw new Error('only BertNormalizer + BertPreTokenizer tokenizers are supported');
  }
  if (cfg.normalize !== true) throw new Error('model must use normalize=true');
  const vocabObj = tok.model.vocab as Record<string, number>;
  const vocab: string[] = [];
  for (const [t, id] of Object.entries(vocabObj)) vocab[id] = t;
  if (vocab.some((t) => t === undefined)) throw new Error('vocab ids are not contiguous');
  const norm = tok.normalizer;
  const lowercase = norm.lowercase !== false;
  const stripAccents = norm.strip_accents ?? lowercase; // HF: null follows lowercase

  const { data, shape } = readSafetensorsF32(join(o.modelDir, 'model.safetensors'), 'embeddings');
  const [rows, dims0] = shape as [number, number];
  if (rows !== vocab.length) throw new Error(`rows ${rows} != vocab ${vocab.length}`);
  const pca = o.pca ?? null;
  const E = pca && pca < dims0 ? pcaReduce(data, rows, dims0, pca) : data;
  const dims = pca && pca < dims0 ? pca : dims0;
  const { matrix, scales } = quantizeRows(E, rows, dims);
  const header: EmbedderHeader = {
    format: 'aidoc-embedder-v1',
    model: o.modelId,
    license: o.license,
    dims,
    rows,
    pca: pca && pca < dims0 ? pca : null,
    tokenizer: {
      type: 'bert-wordpiece',
      vocab,
      unkToken: tok.model.unk_token,
      continuingSubwordPrefix: tok.model.continuing_subword_prefix,
      maxInputCharsPerWord: tok.model.max_input_chars_per_word,
      lowercase,
      stripAccents,
      handleChineseChars: norm.handle_chinese_chars !== false,
      cleanText: norm.clean_text !== false,
    },
    pooling: { dropUnk: true, specialTokens: false, maxTokens: 512, method: 'mean', normalize: 'l2' },
  };
  const d: EmbedderData = { header, matrix, scales };
  return { payload: encodeEmbedder(d), data: d, floatMatrix: E };
}
