/**
 * Analyzer "aidoc-word-v1" (spec §11.3): the word-level analyzer used for BM25,
 * concept-name matching and term overlap. Browser-safe.
 */

// Appendix B of the spec. Keep in sync (a unit test checks it).
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below ' +
    'between both but by can could did do does doing down during each few for from further had has have ' +
    'having he her here hers herself him himself his how i if in into is it its itself just me more most ' +
    'my myself no nor not now of off on once only or other our ours ourselves out over own same she ' +
    'should so some such than that the their theirs them themselves then there these they this those ' +
    'through to too under until up very was we were what when where which while who whom why will with ' +
    'would you your yours yourself yourselves'
  ).split(' '),
);

const MARK = /\p{Mn}/gu;
const SPLIT = /[^\p{L}\p{N}]+/u;

export function isEnglish(language: string): boolean {
  return /^en(-|$)/i.test(language);
}

export function sStem(t: string): string {
  if ([...t].length <= 3) return t;
  if (t.endsWith('ies') && !t.endsWith('eies') && !t.endsWith('aies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('es') && !t.endsWith('aes') && !t.endsWith('ees') && !t.endsWith('oes')) return t.slice(0, -1);
  if (t.endsWith('s') && !t.endsWith('us') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Split into normalized words (steps 1–4), no stopword removal or stemming. */
export function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(MARK, '')
    .toLowerCase()
    .split(SPLIT)
    .filter((w) => w.length > 0);
}

export function analyze(s: string, language = 'en'): string[] {
  const w = words(s);
  if (!isEnglish(language)) return w;
  const out: string[] = [];
  for (const t of w) if (!STOPWORDS.has(t)) out.push(sStem(t));
  return out;
}
