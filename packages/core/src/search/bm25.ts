/** BM25 index (spec §11) and reciprocal rank fusion. Browser-safe. */
import { analyze } from '../text/analyzer.ts';

export interface Bm25Block {
  analyzer: 'aidoc-word-v1';
  k1: number;
  b: number;
  docCount: number;
  avgdl: number;
  docLengths: number[];
  postings: Record<string, number[]>;
}

export function buildBm25(texts: readonly string[], language: string, k1 = 1.2, b = 0.75): Bm25Block {
  const postings: Record<string, number[]> = Object.create(null);
  const docLengths: number[] = [];
  texts.forEach((t, i) => {
    const terms = analyze(t, language);
    docLengths.push(terms.length);
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    for (const [term, n] of tf) (postings[term] ??= []).push(i, n);
  });
  const sum = docLengths.reduce((a, c) => a + c, 0);
  // Plain object with sorted keys for deterministic output.
  const sorted: Record<string, number[]> = {};
  for (const k of Object.keys(postings).sort()) sorted[k] = postings[k]!;
  return { analyzer: 'aidoc-word-v1', k1, b, docCount: texts.length, avgdl: texts.length ? sum / texts.length : 0, docLengths, postings: sorted };
}

export class Bm25 {
  private readonly blk: Bm25Block;
  private readonly postings: Map<string, number[]>;
  readonly language: string;

  constructor(blk: Bm25Block, language: string) {
    this.blk = blk;
    this.language = language;
    this.postings = new Map(Object.entries(blk.postings));
  }

  has(term: string): boolean {
    return this.postings.has(term);
  }

  idf(term: string): number {
    const p = this.postings.get(term);
    const n = p ? p.length / 2 : 0;
    const N = this.blk.docCount;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** Scores for every chunk (dense array). */
  score(query: string): Float32Array {
    const { k1, b, avgdl, docLengths, docCount } = this.blk;
    const out = new Float32Array(docCount);
    const terms = new Set(analyze(query, this.language));
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = this.idf(t);
      for (let i = 0; i < p.length; i += 2) {
        const d = p[i]!;
        const tf = p[i + 1]!;
        out[d]! += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * docLengths[d]!) / avgdl));
      }
    }
    return out;
  }
}

/** Indices sorted by descending score (ties by index), keeping only score > minScore. */
export function rank(scores: ArrayLike<number>, minScore = -Infinity): number[] {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i]! > minScore) idx.push(i);
  return idx.sort((a, c) => scores[c]! - scores[a]! || a - c);
}

/** Reciprocal rank fusion (k = 60). Returns fused scores keyed by index. */
export function rrf(rankings: number[][], k = 60): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rankings) r.forEach((doc, i) => out.set(doc, (out.get(doc) ?? 0) + 1 / (k + i + 1)));
  return out;
}
