import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, sStem, STOPWORDS } from '../src/text/analyzer.ts';
import { WordPieceTokenizer } from '../src/text/tokenizer.ts';
import { StaticEmbedder, decodeEmbedder, f16ToF32, f32ToF16, quantize, dot } from '../src/embed/embedder.ts';
import { prepareEmbedder, symmetricEigen } from '../src/node/prepare-embedder.ts';
import { buildBm25, Bm25, rank, rrf } from '../src/search/bm25.ts';
import { splitSentences } from '../src/text/sentences.ts';

const ROOT = join(import.meta.dirname, '../../..');
const MODEL_DIR = join(ROOT, '.cache/models/potion-base-8M');
const hasModel = existsSync(join(MODEL_DIR, 'model.safetensors'));
const fixture = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8'));

describe('analyzer aidoc-word-v1', () => {
  it('matches the spec test vectors', () => {
    const v: Record<string, string> = { queries: 'query', studies: 'study', horses: 'horse', embeddings: 'embedding', class: 'class', status: 'status', bus: 'bus', goes: 'goe', agrees: 'agree' };
    for (const [a, b] of Object.entries(v)) expect(sStem(a)).toBe(b);
  });
  it('stopword list equals spec Appendix B', () => {
    const spec = readFileSync(join(ROOT, 'spec/aidoc-0.1.md'), 'utf8');
    const block = /## Appendix B[\s\S]*?```\n([\s\S]*?)```/.exec(spec)![1]!.split(/\s+/).filter(Boolean);
    expect([...STOPWORDS].sort()).toEqual(block.sort());
  });
  it('normalizes, drops stopwords, stems; non-English skips steps 5-6', () => {
    expect(analyze('What are the Queries, Keys and Values?')).toEqual(['query', 'key', 'value']);
    expect(analyze('Café Naïve', 'fr')).toEqual(['cafe', 'naive']);
    expect(analyze('the queries', 'de')).toEqual(['the', 'queries']);
  });
});

describe('float16', () => {
  it('round-trips representative values', () => {
    for (const x of [0, 1, -1, 0.5, 65504, 6.1035e-5, 5.96e-8, 0.0078125, 3.14159]) {
      expect(Math.abs(f16ToF32(f32ToF16(x)) - x)).toBeLessThanOrEqual(Math.abs(x) * 1e-3 + 6e-8);
    }
  });
});

describe('symmetricEigen', () => {
  it('diagonalizes a small matrix', () => {
    const A = new Float64Array([4, 1, 2, 1, 3, 0, 2, 0, 1]);
    const { values, vectors } = symmetricEigen(A, 3);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        let av = 0;
        for (let k = 0; k < 3; k++) av += A[r * 3 + k]! * vectors[k * 3 + c]!;
        expect(av).toBeCloseTo(values[c]! * vectors[r * 3 + c]!, 9);
      }
    }
    expect(values[0]).toBeGreaterThanOrEqual(values[1]!);
  });
});

describe('BM25 + RRF', () => {
  it('ranks the matching chunk first', () => {
    const blk = buildBm25(['the cat sat on the mat', 'dogs chase cats', 'attention is all you need'], 'en');
    expect(blk.docCount).toBe(3);
    const s = new Bm25(blk, 'en').score('attention needs');
    expect(rank(s, 0)).toEqual([2]);
    const f = rrf([[0, 1], [1, 0]]);
    expect(f.get(0)).toBeCloseTo(f.get(1)!);
  });
});

describe('sentences', () => {
  it('splits sentences and respects abbreviations', () => {
    expect(splitSentences('Models use attention. For example, e.g. GPT uses it. Done!')).toEqual([
      'Models use attention.',
      'For example, e.g. GPT uses it.',
      'Done!',
    ]);
  });
});

describe.skipIf(!hasModel)('embedder parity with reference (potion-base-8M)', () => {
  let tok: WordPieceTokenizer;
  let embF32: StaticEmbedder; // quantized, full dims
  let floatM: Float32Array;
  let dims = 0;
  let payload: Uint8Array;

  beforeAll(() => {
    const p = prepareEmbedder({ modelDir: MODEL_DIR, modelId: 'minishlab/potion-base-8M', license: 'MIT', pca: null });
    payload = p.payload;
    floatM = p.floatMatrix;
    dims = p.data.header.dims;
    embF32 = new StaticEmbedder(decodeEmbedder(payload));
    tok = embF32.tokenizer;
  });

  it('tokenizer matches HF tokenizers on 500 strings', () => {
    const fx = fixture('tokenizer-parity.json') as { cases: { text: string; ids: number[] }[] };
    expect(fx.cases.length).toBe(500);
    // Documented divergence (decisions D-08): literal special-token text is not matched as a special token.
    const cases = fx.cases.filter((c) => !/\[(CLS|SEP|UNK|MASK|PAD)\]/.test(c.text));
    expect(cases.length).toBe(499);
    const failures = cases.filter((c) => JSON.stringify(tok.encode(c.text)) !== JSON.stringify(c.ids));
    expect(failures.map((f) => ({ text: f.text, got: tok.tokens(f.text), want: f.ids.map((i) => tok.vocab[i]) }))).toEqual([]);
  });

  it('float embedding matches model2vec (cos > 0.99999); int8 embedding cos > 0.995', () => {
    const fx = fixture('embedding-parity.json') as { cases: { text: string; vector: number[] }[] };
    let worstQ = 1;
    for (const c of fx.cases.filter((x) => !/\[(CLS|SEP|UNK|MASK|PAD)\]/.test(x.text))) {
      const ids = tok.encode(c.text).filter((i) => i !== tok.unkId).slice(0, 512);
      const v = new Float32Array(dims);
      for (const id of ids) for (let k = 0; k < dims; k++) v[k]! += floatM[id * dims + k]!;
      const n = Math.hypot(...v) || 1;
      for (let k = 0; k < dims; k++) v[k]! /= n;
      const ref = Float32Array.from(c.vector);
      if (ids.length === 0) continue;
      expect(dot(v, ref)).toBeGreaterThan(0.99999);
      worstQ = Math.min(worstQ, dot(embF32.embed(c.text), ref));
    }
    expect(worstQ).toBeGreaterThan(0.995);
  });

  it('int8 vector quantization keeps cosine', () => {
    const v = embF32.embed('Scaled dot-product attention uses queries and keys.');
    const q = quantize(v);
    let s = 0;
    for (let k = 0; k < dims; k++) s += v[k]! * q[k]!;
    expect(s / 127).toBeGreaterThan(0.995);
  });
});
