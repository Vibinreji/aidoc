/** Cross-reference checks for generated content and the concept graph (spec §14). */

export interface QuizItem {
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}
export interface SectionGenerated {
  summary?: string;
  simpleExplanation?: string;
  keyPoints?: string[];
  quiz?: QuizItem[];
}
export interface FaqEntry {
  id: string;
  question: string;
  alternateQuestions?: string[];
  answer: string;
  sourceSectionIds: string[];
}
export interface GeneratedContent {
  aidoc: string;
  provenance: { generatedBy: string; model?: string; reviewed: boolean; reviewedBy?: string; created: string };
  sections?: Record<string, SectionGenerated>;
  faq?: FaqEntry[];
}
export interface ConceptNode {
  id: string;
  label: string;
  aliases?: string[];
  sectionId?: string;
  description?: string;
}
export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: { from: string; to: string; relation: string }[];
}

export function checkReferences(sectionIds: string[], gen?: GeneratedContent, graph?: ConceptGraph): string[] {
  const errs: string[] = [];
  const secs = new Set(sectionIds);
  if (gen) {
    const quizIds = new Set<string>();
    for (const [sid, s] of Object.entries(gen.sections ?? {})) {
      if (!secs.has(sid)) errs.push(`generated.sections: unknown section "${sid}"`);
      for (const q of s.quiz ?? []) {
        if (quizIds.has(q.id)) errs.push(`quiz id "${q.id}" is not unique`);
        quizIds.add(q.id);
        if (!(Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length)) errs.push(`quiz "${q.id}": answerIndex out of range`);
        if (new Set(q.options).size !== q.options.length) errs.push(`quiz "${q.id}": duplicate options`);
      }
    }
    const faqIds = new Set<string>();
    for (const f of gen.faq ?? []) {
      if (faqIds.has(f.id)) errs.push(`faq id "${f.id}" is not unique`);
      faqIds.add(f.id);
      if (!f.sourceSectionIds?.length) errs.push(`faq "${f.id}": no sourceSectionIds`);
      for (const s of f.sourceSectionIds ?? []) if (!secs.has(s)) errs.push(`faq "${f.id}": unknown section "${s}"`);
    }
  }
  if (graph) {
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      if (ids.has(n.id)) errs.push(`graph node "${n.id}" is not unique`);
      ids.add(n.id);
      if (n.sectionId && !secs.has(n.sectionId)) errs.push(`graph node "${n.id}": unknown section "${n.sectionId}"`);
    }
    const seen = new Set<string>();
    for (const e of graph.edges) {
      if (!ids.has(e.from)) errs.push(`graph edge: unknown node "${e.from}"`);
      if (!ids.has(e.to)) errs.push(`graph edge: unknown node "${e.to}"`);
      const k = `${e.from}\u0000${e.to}\u0000${e.relation}`;
      if (seen.has(k)) errs.push(`graph edge duplicated: ${e.from} ${e.relation} ${e.to}`);
      seen.add(k);
    }
  }
  return errs;
}
