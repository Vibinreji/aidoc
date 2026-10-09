/**
 * The aidoc question engine: rule-based router, hybrid retrieval, FAQ matching,
 * extractive answers, concept paths, summaries and quizzes. No DOM access, so it
 * runs unchanged in Node (tests, calibration, benchmarks) and in the browser.
 *
 * Honesty rules (spec §15.5): answers are only stored generated content or verbatim
 * document text; below the out-of-scope threshold we say the document doesn't cover it.
 */
import { analyze, words, STOPWORDS, sStem, isEnglish } from '@aidoc/core/src/text/analyzer.ts';
import { splitSentences } from '@aidoc/core/src/text/sentences.ts';
import { Bm25, rank, rrf, type Bm25Block } from '@aidoc/core/src/search/bm25.ts';
import { StaticEmbedder, cosineAll, dot } from '@aidoc/core/src/embed/embedder.ts';
import type { ConceptGraph, ConceptNode, FaqEntry, GeneratedContent, QuizItem } from '@aidoc/core/src/node/references.ts';

export interface Chunk {
  id: string;
  sectionId: string;
  headingPath: string[];
  text: string;
  blocks: string[];
  tokens: number;
}

export interface ManifestLike {
  title: string;
  language: string;
  sections: { id: string; title: string; level: number }[];
  provenance: { generatedContent: 'none' | 'author-reviewed' | 'unreviewed' };
  thresholds: { outOfScope: number; cosRef: number; faqMatch: number };
  counts: { chunks: number; faq: number };
}

export interface EngineData {
  manifest: ManifestLike;
  chunks: Chunk[];
  bm25: Bm25Block;
  /** rows × dims int8: chunk rows then FAQ rows; null if vectors/embedder unavailable */
  vectors: Int8Array | null;
  embedder: StaticEmbedder | null;
  generated: GeneratedContent | null;
  graph: ConceptGraph | null;
}

export interface Citation {
  sectionId: string;
  title: string;
  blockId?: string;
}

export interface Sentence {
  text: string;
  chunkIndex: number;
  blockId: string;
  score: number;
}

export interface SearchHit {
  chunkIndex: number;
  sectionId: string;
  headingPath: string[];
  snippet: string;
  blockId: string;
  score: number;
}

export interface PathStep {
  from: ConceptNode;
  to: ConceptNode;
  relation: string;
  /** true if the stored edge points from→to; false if we walked it backwards */
  forward: boolean;
}

export type Answer =
  | { kind: 'faq'; faq: FaqEntry; score: number; citations: Citation[] }
  | { kind: 'extract'; sentences: Sentence[]; citations: Citation[]; more: SearchHit[] }
  | { kind: 'notCovered'; closest: SearchHit[] }
  | { kind: 'search'; query: string; hits: SearchHit[] }
  | { kind: 'generated'; mode: 'summary' | 'simple' | 'keyPoints'; sectionId: string; title: string; text?: string; points?: string[]; citations: Citation[] }
  | { kind: 'docSummary'; items: { sectionId: string; title: string; text: string }[]; citations: Citation[] }
  | { kind: 'quiz'; scope: 'section' | 'document'; sectionId?: string; title: string; items: { sectionId: string; item: QuizItem }[] }
  | { kind: 'relation'; a: ConceptNode; b: ConceptNode; path: PathStep[]; sentences: Sentence[]; citations: Citation[] }
  | { kind: 'concepts'; sectionId?: string; title: string; focus?: ConceptNode; nodes: ConceptNode[]; edges: PathStep[]; citations: Citation[] }
  | { kind: 'message'; text: string; citations: Citation[] };

export type Intent = 'quiz' | 'simple' | 'summary' | 'keyPoints' | 'relation' | 'concepts' | 'find' | 'question';

export interface Route {
  intent: Intent;
  scope: 'current' | 'document' | 'named';
  sectionId?: string;
  concepts: ConceptNode[];
}

export interface AskContext {
  /** Section currently in view; used for "this section" and when no target is named. */
  currentSectionId?: string;
}

interface Name {
  terms: string[];
  node?: ConceptNode;
  sectionId?: string;
}

const RE = {
  quiz: /\b(quiz|test me|test my|practice questions?|examine me|flashcards?)\b/,
  simple:
    /\b(eli5|explain (it |this |that |this section |them )?(simply|like i'?m|in simple|in plain|to a (child|kid|beginner))|simple (terms|words|explanation|version|language)|plain (english|language|words)|simplif(y|ied)|for (a )?(beginner|child|kid|five year old|5 year old)s?|dumb (it )?down)\b/,
  keyPoints: /\b(key points|main points|key takeaways|takeaways|bullet points|main ideas)\b/,
  summary: /\b(summari[sz]e|summary|sum up|sum it up|tl;?dr|recap|gist|overview of|in brief)\b/,
  // Comparisons ("differ", "compare") are answered from the text, not the graph.
  relation: /\b(relat(e|es|ed|ion|ions|ionship|ionships)|connect(ed|ion|s)?|linked|link between|interact(s|ion)?|depend(s)? on)\b/,
  concepts: /\b(key concepts|main concepts|concepts|concept map|related (concepts|topics|ideas))\b/,
  find: /^(where\b|find\b|locate\b|search\b|show me where\b|which (section|part|chapter)\b)|\bwhere (does|do|is|are) (it|this|the) (document|text|article|guide|section)?\b/,
  thisSection: /\b(this|current|the current) (section|part|chapter|page)\b|\bhere\b/,
  wholeDoc: /\b(whole|entire|full) (document|doc|text|article|guide|thing)\b|\beverything\b|\ball (sections|of it|topics)\b|\bthe (document|doc)\b|\bthis (document|doc|article|guide)\b/,
};

const NOT_COVERED_MIN_HITS = 3;
const WH_PENALTY = 0.1;

/** The interrogative of a question ("what", "where", …), or null. "explain"/"describe" count as "what". */
export function questionWord(q: string): string | null {
  const m = /\b(what|where|why|how|when|who|which|explain|describe|define)\b/i.exec(q);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  return w === 'explain' || w === 'describe' || w === 'define' ? 'what' : w;
}

export class Engine {
  readonly d: EngineData;
  private readonly bm25: Bm25;
  private readonly lang: string;
  private readonly sectionTitle = new Map<string, string>();
  private readonly names: Name[] = [];
  private readonly nodeById = new Map<string, ConceptNode>();
  private faqAltVectors: { faqIndex: number; v: Float32Array; wh: string | null }[] | null = null;
  private readonly sentenceCache = new Map<number, { text: string; blockId: string; v: Float32Array | null; terms: string[] }[]>();

  constructor(d: EngineData) {
    this.d = d;
    this.lang = d.manifest.language;
    this.bm25 = new Bm25(d.bm25, this.lang);
    for (const s of d.manifest.sections) this.sectionTitle.set(s.id, s.title);
    for (const n of d.graph?.nodes ?? []) {
      this.nodeById.set(n.id, n);
      for (const label of [n.label, ...(n.aliases ?? [])]) {
        const terms = analyze(label, this.lang);
        if (terms.length) this.names.push({ terms, node: n, sectionId: n.sectionId });
      }
    }
    for (const s of d.manifest.sections) {
      const terms = analyze(s.title, this.lang);
      if (terms.length) this.names.push({ terms, sectionId: s.id });
    }
    this.names.sort((a, b) => b.terms.length - a.terms.length);
  }

  get hasVectors(): boolean {
    return !!(this.d.vectors && this.d.embedder);
  }

  title(sectionId: string): string {
    return this.sectionTitle.get(sectionId) ?? sectionId;
  }

  cite(sectionId: string, blockId?: string): Citation {
    return { sectionId, title: this.title(sectionId), ...(blockId ? { blockId } : {}) };
  }

  // ---- concept / section name matching ---------------------------------------

  /** Concept and section names mentioned in the query (longest match first, non-overlapping). */
  matchNames(query: string): Name[] {
    const q = analyze(query, this.lang);
    const used = new Array<boolean>(q.length).fill(false);
    const hits: { pos: number; name: Name }[] = [];
    for (const name of this.names) {
      const n = name.terms.length;
      for (let i = 0; i + n <= q.length; i++) {
        let ok = true;
        for (let k = 0; k < n && ok; k++) ok = !used[i + k] && q[i + k] === name.terms[k];
        if (!ok) continue;
        for (let k = 0; k < n; k++) used[i + k] = true;
        hits.push({ pos: i, name });
      }
    }
    return hits.sort((a, b) => a.pos - b.pos).map((h) => h.name);
  }

  route(query: string, ctx: AskContext = {}): Route {
    const q = query.toLowerCase().trim();
    const names = this.matchNames(query);
    const concepts: ConceptNode[] = [];
    for (const n of names) if (n.node && !concepts.includes(n.node)) concepts.push(n.node);
    const named = names.find((n) => n.sectionId)?.sectionId;
    let scope: Route['scope'] = 'named';
    let sectionId = named;
    if (RE.thisSection.test(q) || !named) {
      scope = 'current';
      sectionId = ctx.currentSectionId;
    }
    if (RE.wholeDoc.test(q)) {
      scope = 'document';
      sectionId = undefined;
    }
    const r = (intent: Intent): Route => ({ intent, scope, ...(sectionId ? { sectionId } : {}), concepts });
    if (RE.quiz.test(q)) return r('quiz');
    if (RE.simple.test(q)) return r('simple');
    if (RE.keyPoints.test(q)) return r('keyPoints');
    if (RE.summary.test(q)) return r('summary');
    if (RE.relation.test(q) && concepts.length >= 2) return r('relation');
    if (RE.concepts.test(q) || (RE.relation.test(q) && concepts.length === 1 && /\brelated\b/.test(q))) return r('concepts');
    if (RE.find.test(q)) return r('find');
    return r('question');
  }

  // ---- retrieval ---------------------------------------------------------------

  queryVector(query: string): Float32Array | null {
    return this.d.embedder ? this.d.embedder.embed(query) : null;
  }

  chunkCosines(qv: Float32Array): Float32Array {
    const dims = this.d.embedder!.dims;
    return cosineAll(qv, this.d.vectors!, dims, 0, this.d.chunks.length);
  }

  /** Hybrid ranking: RRF over BM25 and cosine rankings. */
  retrieve(query: string, qv: Float32Array | null = this.queryVector(query)): { order: number[]; cos: Float32Array | null; bm: Float32Array } {
    const bm = this.bm25.score(query);
    const bmRank = rank(bm, 0);
    if (!qv || !this.hasVectors) return { order: bmRank, cos: null, bm };
    const cos = this.chunkCosines(qv);
    const fused = rrf([bmRank, rank(cos).slice(0, 50)]);
    const order = [...fused.keys()].sort((a, b) => fused.get(b)! - fused.get(a)! || a - b);
    return { order, cos, bm };
  }

  private sentencesOf(ci: number) {
    let s = this.sentenceCache.get(ci);
    if (s) return s;
    const c = this.d.chunks[ci]!;
    const lines = c.text.split('\n');
    const headings = new Set(c.headingPath);
    s = [];
    lines.forEach((line, li) => {
      if (headings.has(line.trim())) return;
      const blockId = lines.length === c.blocks.length ? c.blocks[li]! : c.blocks[0]!;
      for (const text of splitSentences(line, this.lang)) {
        if (text.split(/\s+/).length < 4) continue;
        s!.push({ text, blockId, v: this.d.embedder ? this.d.embedder.embed(text) : null, terms: analyze(text, this.lang) });
      }
    });
    this.sentenceCache.set(ci, s);
    return s;
  }

  private snippet(ci: number, qTerms: Set<string>): { text: string; blockId: string } {
    const ss = this.sentencesOf(ci);
    let best = ss[0];
    let bestN = -1;
    for (const s of ss) {
      let n = 0;
      for (const t of new Set(s.terms)) if (qTerms.has(t)) n += this.bm25.idf(t);
      if (n > bestN) {
        best = s;
        bestN = n;
      }
    }
    const c = this.d.chunks[ci]!;
    const text = best?.text ?? c.text.slice(0, 200);
    return { text: text.length > 220 ? text.slice(0, 217) + '…' : text, blockId: best?.blockId ?? c.blocks[0]! };
  }

  search(query: string, limit = 8): SearchHit[] {
    const { order } = this.retrieve(query);
    const qTerms = new Set(analyze(query, this.lang));
    return order.slice(0, limit).map((ci, i) => {
      const c = this.d.chunks[ci]!;
      const sn = this.snippet(ci, qTerms);
      return { chunkIndex: ci, sectionId: c.sectionId, headingPath: c.headingPath, snippet: sn.text, blockId: sn.blockId, score: 1 / (60 + i + 1) };
    });
  }

  /** Best chunk cosine, or null in BM25-only mode. */
  bestCos(qv: Float32Array | null): number | null {
    if (!qv || !this.hasVectors) return null;
    const cos = this.chunkCosines(qv);
    let m = -1;
    for (const c of cos) m = Math.max(m, c);
    return m;
  }

  /**
   * Importance-weighted share of the query's content words that occur in the document
   * (spec §15.5). Weights come from the embedder's row norms (rare words weigh more);
   * uniform weights in BM25-only mode.
   */
  coverage(query: string): number {
    let total = 0;
    let found = 0;
    const en = isEnglish(this.lang);
    for (const w of words(query)) {
      if (en && STOPWORDS.has(w)) continue;
      const weight = this.d.embedder ? this.d.embedder.wordWeight(w) : 1;
      total += weight;
      if (this.bm25.has(en ? sStem(w) : w)) found += weight;
    }
    return total > 0 ? found / total : 0;
  }

  /** In-scope score = coverage × min(1, bestCos / cosRef) (spec §15.5). */
  scopeScore(query: string, qv: Float32Array | null = this.queryVector(query)): number {
    const cov = this.coverage(query);
    const best = this.bestCos(qv);
    if (best === null) return cov;
    return cov * Math.min(1, Math.max(0, best) / this.d.manifest.thresholds.cosRef);
  }

  isOutOfScope(query: string, qv: Float32Array | null = this.queryVector(query)): boolean {
    return this.scopeScore(query, qv) < this.d.manifest.thresholds.outOfScope;
  }

  // ---- FAQ ----------------------------------------------------------------------

  private ensureFaqAlternates(): void {
    if (this.faqAltVectors || !this.d.embedder) return;
    this.faqAltVectors = [];
    (this.d.generated?.faq ?? []).forEach((f, i) => {
      for (const alt of f.alternateQuestions ?? []) this.faqAltVectors!.push({ faqIndex: i, v: this.d.embedder!.embed(alt), wh: questionWord(alt) });
    });
  }

  /** Best FAQ entry by cosine over stored question rows and alternate questions, with a lexical guard. */
  matchFaq(query: string, qv: Float32Array | null): { faq: FaqEntry; score: number; coverage: number } | null {
    const faq = this.d.generated?.faq ?? [];
    if (!faq.length || !qv || !this.hasVectors) return null;
    this.ensureFaqAlternates();
    const dims = this.d.embedder!.dims;
    const n = this.d.chunks.length;
    // Question words are stopwords, so neither cosine nor coverage sees "what" vs "where":
    // penalize a variant whose question word differs from the query's.
    const wh = questionWord(query);
    const pen = (other: string | null) => (wh && other && wh !== other ? WH_PENALTY : 0);
    const scores = cosineAll(qv, this.d.vectors!, dims, n, n + faq.length);
    faq.forEach((f, i) => (scores[i] = scores[i]! - pen(questionWord(f.question))));
    for (const a of this.faqAltVectors!) scores[a.faqIndex] = Math.max(scores[a.faqIndex]!, dot(qv, a.v) - pen(a.wh));
    let bi = -1;
    for (let i = 0; i < scores.length; i++) if (bi < 0 || scores[i]! > scores[bi]!) bi = i;
    const f = faq[bi]!;
    const qTerms = [...new Set(analyze(query, this.lang))];
    const fTerms = new Set([f.question, ...(f.alternateQuestions ?? [])].flatMap((s) => analyze(s, this.lang)));
    const coverage = qTerms.length ? qTerms.filter((t) => fTerms.has(t)).length / qTerms.length : 0;
    return { faq: f, score: scores[bi]!, coverage };
  }

  // ---- extractive answers ----------------------------------------------------------

  extract(query: string, qv: Float32Array | null, order: number[], maxSentences = 3, restrictTerms?: Set<string>, chunkWindow = 3): Sentence[] {
    const qTerms = [...new Set(analyze(query, this.lang))];
    const idf = new Map(qTerms.map((t) => [t, this.bm25.idf(t)]));
    const idfSum = [...idf.values()].reduce((a, c) => a + c, 0) || 1;
    const cands: Sentence[] = [];
    order.slice(0, chunkWindow).forEach((ci, rankPos) => {
      this.sentencesOf(ci).forEach((s) => {
        if (restrictTerms && !s.terms.some((t) => restrictTerms.has(t))) return;
        const present = new Set(s.terms);
        let lex = 0;
        for (const [t, w] of idf) if (present.has(t)) lex += w;
        const cos = qv && s.v ? dot(qv, s.v) : 0;
        const score = cos + 0.6 * (lex / idfSum) + 0.04 * Math.max(0, 2 - rankPos);
        cands.push({ text: s.text, chunkIndex: ci, blockId: s.blockId, score });
      });
    });
    cands.sort((a, b) => b.score - a.score);
    if (maxSentences > 3) return cands.slice(0, maxSentences);
    const top = cands[0];
    if (!top) return [];
    const picked = [top];
    for (const c of cands.slice(1)) {
      if (picked.length >= maxSentences) break;
      if (c.score >= top.score * 0.85 && c.chunkIndex === top.chunkIndex) picked.push(c);
    }
    // Present in document order.
    const pos = (s: Sentence) => s.chunkIndex * 1e4 + this.sentencesOf(s.chunkIndex).findIndex((x) => x.text === s.text);
    return picked.sort((a, b) => pos(a) - pos(b));
  }

  private citationsFor(sentences: Sentence[]): Citation[] {
    const out: Citation[] = [];
    for (const s of sentences) {
      const sec = this.d.chunks[s.chunkIndex]!.sectionId;
      if (!out.some((c) => c.sectionId === sec)) out.push(this.cite(sec, s.blockId));
    }
    return out;
  }

  // ---- concept graph -----------------------------------------------------------------

  shortestPath(a: string, b: string): PathStep[] | null {
    const g = this.d.graph;
    if (!g) return null;
    const adj = new Map<string, { to: string; relation: string; forward: boolean }[]>();
    for (const e of g.edges) {
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ to: e.to, relation: e.relation, forward: true });
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ to: e.from, relation: e.relation, forward: false });
    }
    const prev = new Map<string, { from: string; relation: string; forward: boolean }>();
    const seen = new Set([a]);
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === b) break;
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb.to)) continue;
        seen.add(nb.to);
        prev.set(nb.to, { from: cur, relation: nb.relation, forward: nb.forward });
        queue.push(nb.to);
      }
    }
    if (!seen.has(b)) return null;
    const steps: PathStep[] = [];
    for (let cur = b; cur !== a; ) {
      const p = prev.get(cur)!;
      steps.unshift({ from: this.nodeById.get(p.from)!, to: this.nodeById.get(cur)!, relation: p.relation, forward: p.forward });
      cur = p.from;
    }
    return steps;
  }

  neighbors(nodeId: string): PathStep[] {
    const out: PathStep[] = [];
    for (const e of this.d.graph?.edges ?? []) {
      if (e.from === nodeId) out.push({ from: this.nodeById.get(e.from)!, to: this.nodeById.get(e.to)!, relation: e.relation, forward: true });
      else if (e.to === nodeId) out.push({ from: this.nodeById.get(e.to)!, to: this.nodeById.get(e.from)!, relation: e.relation, forward: false });
    }
    return out;
  }

  // ---- intents ------------------------------------------------------------------------

  generatedFor(sectionId: string) {
    return this.d.generated?.sections?.[sectionId];
  }

  summary(mode: 'summary' | 'simple' | 'keyPoints', sectionId: string | undefined): Answer {
    if (!sectionId) return { kind: 'message', text: 'Scroll to a section or name one, for example "summarize attention".', citations: [] };
    const g = this.generatedFor(sectionId);
    const title = this.title(sectionId);
    const cite = [this.cite(sectionId)];
    if (mode === 'keyPoints' && g?.keyPoints?.length) return { kind: 'generated', mode, sectionId, title, points: g.keyPoints, citations: cite };
    const text = mode === 'simple' ? g?.simpleExplanation : g?.summary;
    if (text) return { kind: 'generated', mode, sectionId, title, text, citations: cite };
    const what = mode === 'simple' ? 'simple explanation' : mode === 'keyPoints' ? 'list of key points' : 'summary';
    return { kind: 'message', text: `The author didn't prepare a ${what} for "${title}".`, citations: cite };
  }

  docSummary(): Answer {
    const items: { sectionId: string; title: string; text: string }[] = [];
    for (const s of this.d.manifest.sections) {
      const sum = this.generatedFor(s.id)?.summary;
      if (sum) items.push({ sectionId: s.id, title: s.title, text: splitSentences(sum, this.lang)[0] ?? sum });
    }
    if (!items.length) return { kind: 'message', text: "The author didn't prepare summaries for this document.", citations: [] };
    return { kind: 'docSummary', items, citations: items.map((i) => this.cite(i.sectionId)) };
  }

  quiz(sectionId: string | undefined, document: boolean): Answer {
    const sections = this.d.generated?.sections ?? {};
    if (document || !sectionId) {
      const items: { sectionId: string; item: QuizItem }[] = [];
      for (const s of this.d.manifest.sections) {
        const q = sections[s.id]?.quiz;
        if (q?.length) items.push({ sectionId: s.id, item: q[Math.floor(Math.random() * q.length)]! });
      }
      if (!items.length) return { kind: 'message', text: "The author didn't prepare quiz questions for this document.", citations: [] };
      return { kind: 'quiz', scope: 'document', title: this.d.manifest.title, items: items.slice(0, 10) };
    }
    const q = sections[sectionId]?.quiz ?? [];
    if (!q.length) return { kind: 'message', text: `The author didn't prepare quiz questions for "${this.title(sectionId)}".`, citations: [this.cite(sectionId)] };
    return { kind: 'quiz', scope: 'section', sectionId, title: this.title(sectionId), items: q.map((item) => ({ sectionId, item })) };
  }

  concepts(sectionId: string | undefined, focus?: ConceptNode): Answer {
    const g = this.d.graph;
    if (!g?.nodes.length) return { kind: 'message', text: "This document doesn't include a concept map.", citations: [] };
    if (focus) {
      const edges = this.neighbors(focus.id);
      return { kind: 'concepts', title: focus.label, focus, nodes: [focus, ...edges.map((e) => e.to)], edges, citations: focus.sectionId ? [this.cite(focus.sectionId)] : [] };
    }
    const nodes = sectionId ? g.nodes.filter((n) => n.sectionId === sectionId) : g.nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const edges: PathStep[] = [];
    for (const e of g.edges) if (ids.has(e.from) || ids.has(e.to)) edges.push({ from: this.nodeById.get(e.from)!, to: this.nodeById.get(e.to)!, relation: e.relation, forward: true });
    return { kind: 'concepts', ...(sectionId ? { sectionId } : {}), title: sectionId ? this.title(sectionId) : this.d.manifest.title, nodes, edges, citations: sectionId ? [this.cite(sectionId)] : [] };
  }

  /** True if the text mentions the concept: its label or an alias as a contiguous phrase. */
  mentions(text: string, n: ConceptNode): boolean {
    const t = analyze(text, this.lang);
    return [n.label, ...(n.aliases ?? [])].some((name) => {
      const p = analyze(name, this.lang);
      if (!p.length) return false;
      for (let i = 0; i + p.length <= t.length; i++) if (p.every((x, k) => t[i + k] === x)) return true;
      return false;
    });
  }

  /** For one graph step, the sentence in either concept's section that best states the link. */
  private stepEvidence(st: PathStep): Sentence | undefined {
    const secs = new Set([st.from.sectionId, st.to.sectionId].filter(Boolean));
    const rel = this.queryVector(`${st.from.label} ${st.relation} ${st.to.label}`);
    let best: Sentence | undefined;
    this.d.chunks.forEach((c, ci) => {
      if (!secs.has(c.sectionId)) return;
      for (const s of this.sentencesOf(ci)) {
        const linked =
          (c.sectionId === st.from.sectionId && this.mentions(s.text, st.to)) ||
          (c.sectionId === st.to.sectionId && this.mentions(s.text, st.from)) ||
          (this.mentions(s.text, st.from) && this.mentions(s.text, st.to));
        if (!linked) continue;
        const score = rel && s.v ? dot(rel, s.v) : 0;
        if (!best || score > best.score) best = { text: s.text, chunkIndex: ci, blockId: s.blockId, score };
      }
    });
    return best;
  }

  relation(query: string, a: ConceptNode, b: ConceptNode): Answer {
    const path = this.shortestPath(a.id, b.id) ?? [];
    const sentences: Sentence[] = [];
    for (const st of path.slice(0, 3)) {
      const ev = this.stepEvidence(st);
      if (ev && !sentences.some((x) => x.text === ev.text)) sentences.push(ev);
    }
    if (!sentences.length) {
      // No graph path or no stated link: fall back to the best passages naming each concept.
      const qv = this.queryVector(query);
      const { order } = this.retrieve(`${query} ${a.label} ${b.label}`, qv);
      const restrict = new Set([a, b].flatMap((n) => [n.label, ...(n.aliases ?? [])].flatMap((x) => analyze(x, this.lang))));
      const cands = this.extract(query, qv, order.slice(0, 5), 30, restrict, 5);
      const both = cands.find((s) => this.mentions(s.text, a) && this.mentions(s.text, b));
      if (both) sentences.push(both);
      else for (const n of [a, b]) {
        const s = cands.find((x) => this.mentions(x.text, n));
        if (s) sentences.push(s);
      }
    }
    const cites = this.citationsFor(sentences);
    for (const st of path) for (const n of [st.from, st.to]) if (n.sectionId && !cites.some((c) => c.sectionId === n.sectionId)) cites.push(this.cite(n.sectionId));
    return { kind: 'relation', a, b, path, sentences, citations: cites };
  }

  question(query: string): Answer {
    const qv = this.queryVector(query);
    const { order } = this.retrieve(query, qv);
    const closest = () => this.search(query, NOT_COVERED_MIN_HITS);
    if (this.isOutOfScope(query, qv)) return { kind: 'notCovered', closest: closest() };
    const fm = this.matchFaq(query, qv);
    if (fm && fm.score >= this.d.manifest.thresholds.faqMatch && fm.coverage >= 0.5) {
      return { kind: 'faq', faq: fm.faq, score: fm.score, citations: fm.faq.sourceSectionIds.map((s) => this.cite(s)) };
    }
    const sentences = this.extract(query, qv, order);
    if (!sentences.length) return { kind: 'notCovered', closest: closest() };
    const shown = new Set(sentences.map((s) => s.chunkIndex));
    const more = this.search(query, 5).filter((h) => !shown.has(h.chunkIndex)).slice(0, 3);
    return { kind: 'extract', sentences, citations: this.citationsFor(sentences), more };
  }

  ask(query: string, ctx: AskContext = {}): { route: Route; answer: Answer } {
    const q = query.slice(0, 1000);
    const route = this.route(q, ctx);
    const doc = route.scope === 'document';
    let answer: Answer;
    switch (route.intent) {
      case 'quiz':
        answer = this.quiz(route.sectionId, doc);
        break;
      case 'simple':
      case 'summary':
      case 'keyPoints':
        answer = doc && route.intent === 'summary' ? this.docSummary() : this.summary(route.intent, route.sectionId ?? ctx.currentSectionId);
        break;
      case 'relation':
        answer = this.relation(q, route.concepts[0]!, route.concepts[1]!);
        break;
      case 'concepts':
        answer = this.concepts(route.concepts.length ? undefined : (route.sectionId ?? ctx.currentSectionId), route.concepts[0]);
        break;
      case 'find': {
        const hits = this.search(q);
        answer = this.isOutOfScope(q) ? { kind: 'notCovered', closest: hits.slice(0, NOT_COVERED_MIN_HITS) } : { kind: 'search', query: q, hits };
        break;
      }
      default:
        answer = this.question(q);
    }
    return { route, answer };
  }

  /** Suggested questions for the empty state: FAQ questions spread across sections. */
  suggestions(n = 4): string[] {
    const faq = this.d.generated?.faq ?? [];
    const out: string[] = [];
    const usedSections = new Set<string>();
    for (const f of faq) {
      if (out.length >= n) break;
      const s = f.sourceSectionIds[0]!;
      if (usedSections.has(s)) continue;
      usedSections.add(s);
      out.push(f.question);
    }
    return out;
  }
}

export { words };
